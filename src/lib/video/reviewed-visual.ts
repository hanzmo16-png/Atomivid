import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootageProvider, ImageProvider, ScriptScene } from "@/lib/providers/types";
import { stableHash } from "@/lib/production-intelligence/canonical";
import type { LedgerStore } from "@/lib/paid-calls/gate";
import { createFootageSelectionState, FootageSelectionError, selectFootageForScene, type FootageSelectionState } from "./footage-select";
import { getFeatureFlags } from "./feature-flags";
import { simulateStoryboard } from "./storyboard/simulate";
import { resolveGeneratedImageForScene } from "./visual-resource-resolver";
import { reviewVisual, VisualAssetQualityError } from "./visual-review";
import { requireVisualIntents, type VisualIntent } from "./visual-intent";
import { ESTIMATED_COST_USD } from "@/lib/providers/image/openai";

export function assertReviewedVisualConfiguration(segments: ScriptScene[], ownerPilot: boolean): VisualIntent[] {
  const intents = requireVisualIntents(segments);
  if (ownerPilot) throw new Error("Esta prueba permite solo voz y material de archivo. Las ilustraciones y su revisión necesitan un presupuesto de prueba independiente.");
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("La revisión visual todavía no está configurada. No se inició la narración.");
  const illustrations = intents.filter(intent => intent.source === "illustration").length;
  const flags = getFeatureFlags();
  if (!Number.isFinite(ESTIMATED_COST_USD) || ESTIMATED_COST_USD <= 0) throw new Error("La tarifa de ilustraciones no está configurada correctamente.");
  if (illustrations && (!flags.imageGenerationEnabled || flags.imageProvider !== "openai")) throw new Error("Este tema necesita ilustraciones con IA. Su generación todavía no está habilitada; no se sustituirán por imágenes de otro tema.");
  if (illustrations > flags.maxImagesPerVideo || illustrations * ESTIMATED_COST_USD > flags.maxVisualCostUsd) throw new Error("El tema necesita más ilustraciones de las que permite su presupuesto visual. Ajusta el plan antes de generar.");
  return intents;
}

export { createFootageSelectionState };
export async function resolveReviewedVisual({ service, requestId, sceneIndex, segment, intent, durationSeconds,
  footageProvider, imageProvider, ledger, reviewLedger, state, remainingImageBudgetUsd, mayGenerate,
}: {
  service: SupabaseClient; requestId: string; sceneIndex: number; segment: ScriptScene; intent: VisualIntent; durationSeconds: number;
  footageProvider: FootageProvider; imageProvider?: ImageProvider; ledger: LedgerStore; state: FootageSelectionState;
  reviewLedger?: LedgerStore;
  remainingImageBudgetUsd: number; mayGenerate: boolean;
}) {
  let reviewCostUsd = 0;
  let acceptedBuffer: Buffer | undefined;
  const verify = async (buffer: Buffer, mediaType: "image" | "video") => {
    let review;
    try {
      review = await reviewVisual({ service, requestId, sceneIndex, intent, narration: segment.text, buffer, mediaType, durationSeconds,
        ...(reviewLedger ? { ledger: reviewLedger } : {}) });
    } catch (error) {
      if (!(error instanceof VisualAssetQualityError)) throw error;
      console.log("[atomivid:visual-review]", JSON.stringify({ requestId, sceneIndex, mediaType, accepted: false, reason: error.message, costUsd: 0, technicalRejection: true }));
      return false;
    }
    reviewCostUsd += review.costUsd;
    console.log("[atomivid:visual-review]", JSON.stringify({ requestId, sceneIndex, mediaType, accepted: review.accepted, reused: review.reused, reason: review.verdict.reason, costUsd: review.costUsd }));
    if (review.accepted) acceptedBuffer = buffer;
    return review.accepted;
  };
  if (intent.source === "stock") {
    try {
      const outcome = await selectFootageForScene({ provider: footageProvider,
        concepts: [segment.visualQuery, ...(segment.visualConcepts ?? []).filter(q => q !== segment.visualQuery)],
        minimumDurationSeconds: durationSeconds + 0.5, state,
        verifyCandidate: async candidate => verify(await footageProvider.downloadFootage(candidate.url), candidate.mediaType),
      });
      if (!acceptedBuffer) throw new Error("No se pudo recuperar el material visual aprobado.");
      const assetPath = `${requestId}/reviewed/scene-${sceneIndex}-${stableHash(intent)}.${outcome.result.extension}`;
      const uploaded = await service.storage.from("videos").upload(assetPath, acceptedBuffer, { contentType: outcome.result.mimeType, upsert: true });
      if (uploaded.error) throw new Error("No se pudo guardar el material visual aprobado.");
      const signed = await service.storage.from("videos").createSignedUrl(assetPath, 3600);
      if (signed.error || !signed.data) throw new Error("No se pudo acceder al material visual aprobado.");
      return { url: signed.data.signedUrl, mediaType: outcome.result.mediaType, imageCostUsd: 0, reviewCostUsd, generated: false, requestedImage: false, storageBytes: acceptedBuffer.length };
    } catch (error) {
      // Vision/budget/provider errors stop immediately; only a genuine no-match may generate.
      if (!(error instanceof FootageSelectionError)) throw error;
    }
  }
  if (!mayGenerate || !imageProvider || imageProvider.name !== "openai" || remainingImageBudgetUsd < ESTIMATED_COST_USD) throw new Error(`No se encontró una imagen que represente "${intent.subject}". La ilustración necesaria no cabe en el presupuesto o no está habilitada; no se usará un sustituto incorrecto.`);
  const scaffold = simulateStoryboard({ title: "Visual review", segments: [segment] }).scenes[0];
  const scene = { ...scaffold, id: `scene-${sceneIndex}`, subject: intent.subject, visibleAction: intent.mustShow.join("; "),
    resourceType: "generated_image" as const, imagePrompt: `${intent.imagePrompt}\nRequired visible subject: ${intent.subject}. Required traits/actions: ${intent.mustShow.join("; ")}. Compose a polished, sharp, well-lit image with coherent subject anatomy and geometry. Keep all defining features/action clearly visible within the central 75% of a vertical 9:16 safe area, leaving room for the camera zoom. No watermark, unrelated lettering, duplicated or fused body parts, blur or compression artifacts. This is a creative illustration, not documentary evidence.`,
    negativePrompt: intent.mustNotShow.join(", "), maxCostUsd: ESTIMATED_COST_USD };
  const generated = await resolveGeneratedImageForScene({ supabase: service, bucket: "videos", requestId,
    artifactPrefix: `${requestId}/reviewed/${stableHash({ prompt: scene.imagePrompt, negative: scene.negativePrompt }, 32)}`,
    disableProviderRetries: true, sceneIndex, scene, imageProvider,
    remainingBudgetUsd: Math.min(ESTIMATED_COST_USD, remainingImageBudgetUsd), signedUrlTtlSeconds: 3600, ledger });
  const bytes = await footageProvider.downloadFootage(generated.url);
  if (!(await verify(bytes, "image"))) throw new Error(`La ilustración de "${intent.subject}" no pasó la revisión visual. No se exportó un reel con esa imagen.`);
  return { url: generated.url, mediaType: "image" as const, imageCostUsd: generated.costUsd, reviewCostUsd,
    generated: generated.status === "generated", requestedImage: true, storageBytes: generated.bufferBytes };
}
