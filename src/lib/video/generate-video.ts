import { SupplyUnavailableError } from "@/lib/supply/policy";
import { verifyDeliverableMp4 } from "@/lib/video/deliverable-check";
import { reelNarration } from "./reel-narration";
import { getPricingConfig } from "@/lib/billing/pricing";
import { gatedMusicTrack, gatedVoiceSynthesize, type PaidCallDeps } from "@/lib/paid-calls/gated-providers";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import { buildCaptions } from "./captions";
import { VIDEO_TAIL_SECONDS } from "./script-pacing";
import { ProviderConfigurationError } from "@/lib/providers/production";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getFootageProvider } from "@/lib/providers/footage";
import { getMusicProvider } from "@/lib/providers/music";
import type { GeneratedScript, MusicResult, ScriptLanguage } from "@/lib/providers/types";
import { alignScenesToWords } from "./scene-timings";
import type { RenderStage } from "@/lib/video/stages";
import type { Caption, Scene } from "../../../remotion/VerticalReel";
import { computeNarrationGaps, type NarrationGap } from "../../../remotion/audio-mix";
import { recordVideoGeneration } from "@/lib/billing/usage";
import { splitIntoBeats } from "@/lib/video/scene-beats";
import { createFootageSelectionState, selectFootageForScene } from "@/lib/video/footage-select";
import { checkDuration, assertNarrationDuration } from "@/lib/video/duration-check";
import { LOUDNESS_TARGET, masterAudioLoudness } from "@/lib/video/audio-master";
import { buildEmphasisSet } from "@/lib/video/caption-emphasis";
import { getAccentColor, shouldShowLogo } from "@/lib/video/brand";
import { evaluateQualityGate, QUALITY_GATE_MIN_SCORE } from "@/lib/video/quality-gate";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { buildStoryboard } from "@/lib/video/storyboard";
import type { Storyboard } from "@/lib/video/storyboard/types";
import { getImageProvider } from "@/lib/providers/image";
import { decideResourceStrategy, buildScenePlanEntry, type ScenePlanEntry } from "@/lib/video/visual-resource-planner";
import { resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";
import { cinematicDirectorRenderEnabled } from "@/lib/video/director/flag";
import type { ResolvedBeat } from "@/lib/video/director/reel-render";
import { footageResultLicense, GENERATED_IMAGE_LICENSE, licenseBlockAfterVoiceMessage } from "@/lib/video/director/beat-license";
import { cardWindows, dataCardSvg, directorReelPreflight, DirectorPreflightBlockedError, MIN_CARD_SECONDS, neutralCardSvg, tokenSlice, type DataCardPlan } from "@/lib/video/director/data-card";

// Deliberadamente separado de generate-script.ts — ver el comentario ahí
// para la razón exacta (Remotion no debe cargarse en la ruta de guion).
// Este módulo (voz/footage/música/render) solo lo importan el worker
// inline (fallback de desarrollo, ver src/lib/video/run-job.ts) y el
// script de prueba end-to-end con fixtures.

const STORAGE_BUCKET = "videos";
const COMPOSITION_ID = "VerticalReel";
// El bucket es privado: los assets intermedios (voz/footage/música) se
// firman por un rato corto, solo el tiempo que tarda este mismo proceso en
// leerlos para el render — no necesitan durar más que eso.
const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;

type OnProgress = (stage: RenderStage) => void | Promise<void>;

/**
 * Etapa 2 del pipeline: a partir de un guion ya aprobado (generado o
 * editado por el usuario), sintetiza voz, busca footage, agrega música,
 * arma subtítulos y renderiza el video final.
 */
export async function generateVideoFromScript({
  supabase,
  requestId,
  artifactPrefix = requestId,
  script,
  style,
  topic,
  language = "es",
  voiceId,
  targetDurationSeconds,
  onProgress,
  paidCalls,
  directorRender = false,
  directorMaterialBudgetUsd,
  directorAdapter,
}: {
  supabase: SupabaseClient;
  /** Montar con el plan del Director. Lo decide SOLO el worker (run-job.ts → resolveDirectorRender): flag global + piloto + Reel visual. */
  directorRender?: boolean;
  /**
   * Anexo C1: new Director material this attempt may still buy (owner tests only), read from its own image envelope
   * when needed. Absent or 0 = none, the previous rule. See material-fill.ts.
   */
  directorMaterialBudgetUsd?: () => Promise<number>;
  /**
   * Test seam (local E2E only; no production caller): Director adapter options such as a faster-cut shot length,
   * so a fixture run can reach «more shots than resolved material» and exercise the fill end to end.
   */
  directorAdapter?: import("@/lib/video/director/from-reel").ReelAdapterOptions;
  paidCalls?: Pick<PaidCallDeps, "ledger" | "results">;
  requestId: string;
  artifactPrefix?: string;
  script: GeneratedScript;
  /** Estilo elegido por el usuario (p. ej. "Motivacional") — usado para elegir música acorde. */
  style?: string;
  /** Tema original de la solicitud — señal adicional para el tono musical (ver providers/music/tone.ts). */
  topic?: string;
  language?: ScriptLanguage;
  /** Validated at creation and persisted separately from editable/generated script content. */
  voiceId?: string;
  /** Duración objetivo original de la solicitud (video_requests.duration_seconds) — para advertir si la narración real se sale de tolerancia (±10%). Ausente = no se verifica. */
  targetDurationSeconds?: number;
  onProgress?: OnProgress;
}): Promise<{ videoPath: string }> {
  const { voiceProvider, voiceIdentity } = reelNarration(language, voiceId);
  const footageProvider = getFootageProvider();
  const musicProvider = getMusicProvider();
  const imageProvider = getFeatureFlags().imageGenerationEnabled ? getImageProvider() : undefined;
  const gate: PaidCallDeps = {
    ledger: paidCalls?.ledger ?? supabaseLedgerStore(supabase),
    results: paidCalls?.results ?? supabaseResultStore(supabase, STORAGE_BUCKET), requestId,
  };
  const synthesizeGated = (text: string, speed?: number) => gatedVoiceSynthesize({ ...gate, voiceProvider,
    voiceIdentity,
    estimatedCostUsd: text.length / 1000 * getPricingConfig().elevenLabsUsdPer1kChars }, text, language, speed);
  let storageBytes = 0;

  // 0. Storyboard semántico (Visual Director) — detrás de
  // VISUAL_DIRECTOR_ENABLED (apagado por defecto, ver feature-flags.ts),
  // nunca bloquea el render si falla. Cuando SÍ se genera, alimenta al
  // planificador visual de abajo (decideResourceStrategy) para decidir,
  // escena por escena, si conviene una imagen generada en vez de stock —
  // con el flag apagado, `storyboard` queda undefined y esa decisión
  // siempre cae a stock (comportamiento idéntico al de antes de esta
  // función existir). Tampoco escribe en video_requests.storyboard_json
  // porque esa columna depende de la migración 0010, que no se aplica
  // sola (ver supabase/migrations/0010_visual_director.sql).
  let storyboard: Storyboard | undefined;
  if (getFeatureFlags().visualDirectorEnabled) {
    try {
      const built = await buildStoryboard(script, language);
      storyboard = built.storyboard;
      console.log(
        "[atomivid:storyboard]",
        JSON.stringify({
          requestId,
          source: built.source,
          totalScenes: storyboard.scenes.length,
          hookDescription: storyboard.hookDescription,
          closingDescription: storyboard.closingDescription,
          resourceTypes: storyboard.scenes.map((s) => s.resourceType),
        }),
      );
    } catch (err) {
      if (err instanceof SupplyUnavailableError) throw err;
      if (err instanceof ProviderConfigurationError) throw err;
      console.warn(
        `[atomivid:storyboard] ${requestId} — no se pudo generar el storyboard, se continúa con el flujo actual:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 1. Voz narrada completa en una sola llamada, con timestamps por
  // palabra (así toda la narración usa la misma voz y ritmo).
  await onProgress?.("voice");
  const fullText = script.segments.map((s) => s.text).join(" ");
  // T36 C2: what this attempt already spent on narration, so a later licence block can report it truthfully.
  const voiceSpend = { calls: 0, costUsd: 0 };
  const synthesizeCounted = async (text: string, speed?: number) => {
    const r = await synthesizeGated(text, speed);
    voiceSpend.calls += 1;
    voiceSpend.costUsd += r.costUsd;
    return r;
  };
  let voice = await synthesizeCounted(fullText);

  // Verificación de duración REAL (no estimada) contra el objetivo de la
  // solicitud — nunca estira ni recorta el audio ya grabado (eso sonaría
  // artificial), rechaza cuando el guion quedó fuera de tolerancia (±10%)
  // para poder recalibrar WORDS_PER_SECOND (script-pacing.ts) con datos
  // reales en vez de dejarlo pasar en silencio. Causa raíz confirmada del
  // defecto "duración ~28% menor que la pedida" en el video auditado.
  //
  // Antes de rendirse: una sola corrección de RITMO (voiceProvider habla
  // más rápido/lento, nunca reescribe el texto ya aprobado por el usuario
  // en la revisión) proporcional a cuánto se pasó/quedó corto. Confirmado
  // en producción (2026-09-20) que el conteo de palabras por sí solo no
  // siempre predice bien la duración real hablada — esta corrección ataca
  // la causa real (el ritmo de esta síntesis en particular) sin gastar en
  // un guion nuevo ni pedirle al usuario que vuelva a revisar texto que no
  // escribió. Si tras la corrección sigue fuera de tolerancia, se rinde
  // igual que antes: assertNarrationDuration lanza y no se sigue.
  let durationWithinTolerance = true;
  if (targetDurationSeconds !== undefined) {
    let durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    if (!durationResult.withinTolerance) {
      const correctedSpeed = voice.durationSeconds / targetDurationSeconds;
      const correctedVoice = await synthesizeCounted(fullText, correctedSpeed);
      const correctedResult = checkDuration(targetDurationSeconds, correctedVoice.durationSeconds);
      voice = correctedVoice;
      durationResult = correctedResult;
    }
    durationWithinTolerance = durationResult.withinTolerance;
    if (!durationResult.withinTolerance) {
      assertNarrationDuration(targetDurationSeconds, voice.durationSeconds);
    }
  }

  // 2. Repartir el tiempo de la narración real entre las escenas del guion
  const sceneTimings = alignScenesToWords(script.segments, voice.words, voice.durationSeconds);

  // 3. Footage: varios candidatos por escena (y por "beat" visual dentro
  // de escenas largas), puntuados y deduplicados contra todo lo ya usado
  // en este video — reemplaza el patrón anterior (una sola búsqueda de
  // 2-4 palabras, primer resultado, sin memoria entre escenas), causa
  // raíz confirmada de "solo ~4 clips distintos" y "atardecer repetido"
  // en el video auditado. Ver footage-select.ts para el detalle.
  await onProgress?.("footage");
  const footageState = createFootageSelectionState();
  const scenes: Scene[] = [];
  const footageSelections: Array<{
    sceneIndex: number;
    beatIndex: number;
    queryUsed: string;
    conceptTier: number;
    usedFallbackQuery: boolean;
    candidatesConsidered: number;
    reason: string;
    sourceId: string;
    providerDescription?: string;
    providerPageUrl?: string;
    openingRelevance?: import("./opening-relevance").OpeningRelevance;
  }> = [];
  // Planificador visual (imagen generada vs. stock) — ver
  // visual-resource-planner.ts para la política completa. Con
  // VISUAL_DIRECTOR_ENABLED=false (default) `storyboard` es undefined y
  // decideResourceStrategy() siempre devuelve useGeneration:false en su
  // primer chequeo, así que este bloque nunca cambia el comportamiento
  // existente cuando el flag está apagado.
  const visualPlan: ScenePlanEntry[] = [];
  // Material really resolved per segment and beat — what the Director may arrange (only read with its flag on).
  const directorBeats: ResolvedBeat[][] = script.segments.map(() => []);
  // T42: under the Director a sentence with measurable data gets a deterministic data card (its exact figure and
  // wording) instead of illustrative stock the policy would only accept "with review". Sentences the Director
  // cannot honour at all were refused by run-job BEFORE narration; this re-check is defence in depth.
  const directorCards = directorRender ? directorReelPreflight(script) : { cards: [], blockers: [] };
  if (directorRender && directorCards.blockers.length) throw new DirectorPreflightBlockedError(directorCards.blockers);
  const cardsByScene = new Map<number, DataCardPlan[]>();
  for (const c of directorCards.cards) cardsByScene.set(c.sceneIndex, [...(cardsByScene.get(c.sceneIndex) ?? []), c].sort((x, y) => x.index - y.index));
  // Word offsets per scene, counted exactly like alignScenesToWords, to place each card on its claim's narration.
  const wordOffsets: number[] = [];
  { let off = 0; for (const s of script.segments) { wordOffsets.push(off); off += s.text.split(/\s+/).filter(Boolean).length; } }
  let imagesRequestedCount = 0;
  let imagesGeneratedCount = 0;
  let imagesReusedCount = 0;
  let visualCostSpentUsd = 0;
  let usedGeneratedImageProvider: string | null = null;
  let usedGeneratedImageModel: string | null = null;
  let usedGeneratedImageSize: string | null = null;

  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const timing = sceneTimings[i];
    const cards = directorRender ? cardsByScene.get(i) : undefined;
    if (cards?.length) {
      // T42/T44: the cards cover the whole scene, ONE PER CLAIM, each on the narration window of its claim measured on
      // the real voice (word timestamps; proportional only if the voice gave none). No footage search, no download,
      // no provider: deterministic SVGs. A card switches exactly when the next claim starts being said.
      // Correction 1 (T44): windows are NEVER merged. A card keeps its identity and exactly its own window, however
      // short; a claim too short to own a window was refused by the preflight before any spend (MIN_CARD_TOKENS).
      // Correction 2 (GATE 2): every boundary the voice's word clock knows is kept. A window the clock cannot attribute
      // to one claim (degenerate timestamps) or shorter than MIN_CARD_SECONDS shows the NEUTRAL slate (no figure) for
      // exactly its own time: nothing is stretched, nothing redistributed, no second voice is requested.
      const count = segment.text.split(/\s+/).filter(Boolean).length;
      const sceneWords = voice.words.slice(wordOffsets[i], wordOffsets[i] + count);
      const windows = cardWindows(cards, timing.start, timing.end, count > 0 && sceneWords.length === count ? sceneWords.map((w) => w.startSeconds) : null);
      for (let k = 0; k < windows.length; k++) {
        const w = windows[k];
        const neutral = w.treatment === "neutral";
        const svg = Buffer.from(neutral ? neutralCardSvg({ reason: w.neutralReason ?? "short_window" }) : dataCardSvg({ text: w.card.text, figure: w.card.figure, figures: w.card.figures }), "utf8");
        storageBytes += svg.byteLength;
        const { url: cardUrl } = await uploadToStorage(supabase, `${artifactPrefix}/card-${i}-${k}.svg`, svg, "image/svg+xml");
        scenes.push({ mediaUrl: cardUrl, mediaType: "image", startSeconds: w.start, endSeconds: w.end });
        const windowText = tokenSlice(segment.text, w.fromToken, w.toToken) || w.card.windowText;
        directorBeats[i].push({ url: cardUrl, mediaType: "image", source: "data_card", license: "CLEARED", start: w.start, end: w.end,
          card: neutral ? { text: "", windowText, figures: [], treatment: "neutral", neutralReason: w.neutralReason ?? "short_window", timing: w.timing }
            : { text: w.card.text, windowText, figures: w.card.figures, treatment: "card", timing: w.timing } });
        console.log("[atomivid:director]", JSON.stringify({ requestId, sceneIndex: i, card: k, dataCard: neutral ? "(tarjeta neutral, sin cifra)" : w.card.figures.map((f) => f.display).join(" · ") || "(sin cifra)",
          treatment: w.treatment, neutralReason: w.neutralReason ?? null, ambiguousBetween: w.ambiguousBetween ?? null, timing: w.timing, start: w.start, end: w.end, shortWindow: w.end - w.start < MIN_CARD_SECONDS }));
      }
      continue;
    }
    const beats = splitIntoBeats(timing.start, timing.end);
    const baseConcepts =
      segment.visualConcepts && segment.visualConcepts.length > 0
        ? segment.visualConcepts
        : [segment.visualQuery];
    const storyboardScene = storyboard?.scenes[i];

    for (let b = 0; b < beats.length; b++) {
      const beat = beats[b];
      const beatDuration = Math.max(0, beat.end - beat.start);
      // Beats después del primero dentro de la misma escena empiezan por
      // un concepto distinto (si hay más de uno) para variar el plano en
      // vez de repetir la misma búsqueda dentro de la propia escena.
      const rotation = b % baseConcepts.length;
      const beatConcepts = [...baseConcepts.slice(rotation), ...baseConcepts.slice(0, rotation)];

      // La generación pagada solo se considera para el PRIMER beat de
      // cada escena — como mucho una imagen generada por escena del
      // guion, nunca una por cada sub-plano, para mantener el costo
      // acotado y predecible (documentado, no un límite oculto).
      const decision =
        b === 0
          ? decideResourceStrategy(storyboardScene, imagesRequestedCount, visualCostSpentUsd)
          : ({ useGeneration: false, reason: "solo el primer beat de cada escena es candidato a generación" } as const);

      let resolvedViaGeneration = false;
      if (decision.useGeneration && imageProvider) {
        imagesRequestedCount += 1;
        try {
          const remainingBudgetUsd = Math.max(0, getFeatureFlags().maxVisualCostUsd - visualCostSpentUsd);
          const generated = await resolveGeneratedImageForScene({
            ledger: gate.ledger,
            supabase,
            bucket: STORAGE_BUCKET,
            requestId,
            sceneIndex: i,
            scene: decision.scene,
            imageProvider,
            remainingBudgetUsd: Math.min(remainingBudgetUsd, decision.estimatedCostUsd),
            signedUrlTtlSeconds: ASSET_SIGNED_URL_TTL_SECONDS,
          });

          storageBytes += generated.bufferBytes;
          visualCostSpentUsd += generated.costUsd;
          usedGeneratedImageProvider = generated.provider;
          usedGeneratedImageModel = generated.model ?? usedGeneratedImageModel;
          if (generated.width && generated.height) {
            usedGeneratedImageSize = `${generated.width}x${generated.height}`;
          }
          if (generated.status === "generated") imagesGeneratedCount += 1;
          else imagesReusedCount += 1;

          scenes.push({
            mediaUrl: generated.url,
            mediaType: "image",
            startSeconds: beat.start,
            endSeconds: beat.end,
          });
          directorBeats[i].push({ url: generated.url, mediaType: "image", source: "generated", license: GENERATED_IMAGE_LICENSE, start: beat.start, end: beat.end });
          visualPlan.push({
            ...buildScenePlanEntry(i, b, beatDuration, segment.text, beatConcepts[0], decision),
            provider: generated.provider,
            estimatedCostUsd: generated.costUsd,
          });
          console.log(
            "[atomivid:visual]",
            JSON.stringify({ requestId, sceneIndex: i, status: generated.status, provider: generated.provider, costUsd: generated.costUsd }),
          );
          resolvedViaGeneration = true;
        } catch (err) {
      if (err instanceof SupplyUnavailableError) throw err;
          // Nunca cae a otro proveedor de PAGO como sustituto silencioso —
          // solo se registra el fallo y se sigue con stock (gratis) abajo.
          console.warn(
            `[atomivid:visual] ${requestId} — falló la generación de imagen para la escena ${i}, se usa stock:`,
            err instanceof Error ? err.message : err,
          );
          visualPlan.push(buildScenePlanEntry(i, b, beatDuration, segment.text, beatConcepts[0], {
            useGeneration: false,
            reason: `fallo del proveedor de imagen, fallback a stock: ${err instanceof Error ? err.message : "error desconocido"}`,
          }));
        }
      } else if (b === 0) {
        visualPlan.push(buildScenePlanEntry(i, b, beatDuration, segment.text, beatConcepts[0], decision));
      }

      if (resolvedViaGeneration) continue;

      const outcome = await selectFootageForScene({
        provider: footageProvider,
        concepts: beatConcepts,
        minimumDurationSeconds: beatDuration + 0.5,
        state: footageState,
        isOpening: i === 0,
        excludedTerms: segment.excludedTerms,
      });

      footageSelections.push({
        sceneIndex: i,
        beatIndex: b,
        queryUsed: outcome.queryUsed,
        conceptTier: outcome.conceptTier,
        usedFallbackQuery: outcome.usedFallbackQuery,
        candidatesConsidered: outcome.candidatesConsidered,
        reason: outcome.reason,
        sourceId: outcome.sourceId,
        providerDescription: outcome.providerDescription,
        providerPageUrl: outcome.providerPageUrl,
        openingRelevance: outcome.openingRelevance,
      });

      // T36 C1: the licence travels with the beat. Under the Director a non-cleared result stops the render now,
      // before any further download, paid image or render — never a silent classic montage.
      const license = footageResultLicense(footageProvider, outcome.result);
      if (directorRender && license !== "CLEARED" && cinematicDirectorRenderEnabled()) {
        // The narration is already synthesized at this point (footage needs its timings): freeze what was spent in
        // this attempt's evidence and say so. The reservation of what was NOT used is released by run-job.
        const block = { scene: i + 1, license, voiceCalls: voiceSpend.calls, voiceCostUsd: voiceSpend.costUsd, reconciliationRequired: voiceSpend.costUsd > 0 };
        await uploadToStorage(supabase, `${artifactPrefix}/license-block.json`, Buffer.from(JSON.stringify(block, null, 2)), "application/json");
        console.log("[atomivid:director]", JSON.stringify({ requestId, licenseBlock: block }));
        throw new Error(licenseBlockAfterVoiceMessage(i + 1, license, voiceSpend));
      }
      const footageBuffer = await footageProvider.downloadFootage(outcome.result.url);
      storageBytes += footageBuffer.byteLength;
      const { url: mediaUrl } = await uploadToStorage(
        supabase,
        `${artifactPrefix}/scene-${i}-${b}.${outcome.result.extension}`,
        footageBuffer,
        outcome.result.mimeType,
      );
      scenes.push({
        mediaUrl,
        mediaType: outcome.result.mediaType,
        startSeconds: beat.start,
        endSeconds: beat.end,
      });
      directorBeats[i].push({ url: mediaUrl, mediaType: outcome.result.mediaType, source: footageProvider.name === "fixture" ? "fixture" : "stock", license, start: beat.start, end: beat.end });
    }
  }

  if (visualPlan.length > 0) {
    console.log(
      "[atomivid:visual-plan]",
      JSON.stringify({
        requestId,
        imagesRequestedCount,
        imagesGeneratedCount,
        imagesReusedCount,
        visualCostSpentUsd,
        plan: visualPlan,
      }),
    );
  }

  console.log(
    "[atomivid:footage] selección de clips",
    JSON.stringify({ requestId, totalBeats: scenes.length, selections: footageSelections }),
  );

  // Puerta de calidad preventiva (no bloqueante todavía — ver el
  // comentario en quality-gate.ts) — se calcula ANTES del paso más caro
  // en cómputo que queda (el render de Remotion), con los datos reales de
  // la selección de footage ya hecha.
  const qualityGate = evaluateQualityGate({
    totalBeats: scenes.length,
    // footage-select.ts garantiza por construcción que nunca se reutiliza
    // un sourceId dentro del mismo video (ver su `state.usedSourceIds`) —
    // por eso la cantidad de candidatos únicos es siempre igual al total
    // de beats; se registra igual como valor real, no supuesto, por si
    // esa garantía se rompiera algún día (el score de diversidad bajaría
    // y quedaría en los logs de este propio gate, no en silencio).
    uniqueSourceIds: footageState.usedSourceIds.size,
    fallbackCount: footageSelections.filter((s) => s.usedFallbackQuery).length,
    averageConceptTier:
      footageSelections.length > 0
        ? footageSelections.reduce((sum, s) => sum + s.conceptTier, 0) / footageSelections.length
        : 0,
    beatDurations: scenes.map((s) => s.endSeconds - s.startSeconds),
    durationWithinTolerance,
  });
  console.log(
    "[atomivid:quality-gate]",
    JSON.stringify({ requestId, ...qualityGate }),
  );
  if (!qualityGate.passed) {
    console.warn(
      `[atomivid:quality-gate] ${requestId} — score ${qualityGate.score} por debajo del mínimo ` +
        `sugerido (${QUALITY_GATE_MIN_SCORE}): ${qualityGate.reasons.join("; ")}`,
    );
  }

  // 4. Subir la narración generada
  storageBytes += voice.audioBuffer.byteLength;
  const { url: audioUrl } = await uploadToStorage(
    supabase,
    `${artifactPrefix}/voice.${voice.extension}`,
    voice.audioBuffer,
    voice.mimeType,
  );

  // 5. Música de fondo, seleccionada por tono (tema + estilo + guion) y
  // mezclada por debajo de la narración (ver remotion/audio-mix.ts). Un
  // fallo aquí (proveedor caído, sin coincidencia, descarga corrupta) NO
  // debe tumbar el video completo — se continúa sin música, mezclando la
  // razón claramente en logs y en el registro de costo, nunca en silencio
  // absoluto (ver Fase 4/6 de la especificación de esta etapa).
  await onProgress?.("music");
  const finalDurationSeconds = voice.durationSeconds + VIDEO_TAIL_SECONDS;
  let music: MusicResult | null = null;
  let musicFallbackReason: string | null = null;
  try {
    music = await gatedMusicTrack({ ...gate, musicProvider, estimatedCostUsd: Number(process.env.BEATOVEN_ESTIMATED_COST_USD || "0") }, {
      durationSeconds: finalDurationSeconds,
      style,
      topic,
      scriptText: fullText,
      language,
      seed: requestId,
    });
  } catch (err) {
      if (err instanceof SupplyUnavailableError) throw err;
    const errorName = err instanceof Error ? err.name : "Error";
    const errorMessage = err instanceof Error ? err.message : String(err);
    musicFallbackReason = `${errorName}: ${errorMessage}`;
    console.warn(
      `[atomivid:music] ${requestId} — no se pudo obtener música, el video se genera sin ella:`,
      musicFallbackReason,
    );
  }

  let musicUrl: string | undefined;
  if (music) {
    storageBytes += music.audioBuffer.byteLength;
    const uploaded = await uploadToStorage(
      supabase,
      `${artifactPrefix}/music.${music.extension}`,
      music.audioBuffer,
      music.mimeType,
    );
    musicUrl = uploaded.url;
    console.log(
      "[atomivid:music] pista seleccionada",
      JSON.stringify({
        requestId,
        musicProvider: musicProvider.name,
        ...(music.track ?? { note: "sin metadata (modo MUSIC_TRACK_URLS sin manifest)" }),
      }),
    );
  }

  // 6. Subtítulos incrustados: frases naturales (corte en puntuación),
  // máximo 2 líneas, respetando finales de oración, con palabras clave
  // marcadas para énfasis visual (ver caption-emphasis.ts).
  const scriptEmphasisWords = script.segments.flatMap((s) => s.emphasisWords ?? []);
  const emphasisSet = buildEmphasisSet(scriptEmphasisWords);
  const captions = buildCaptions(voice.words, emphasisSet);
  const narrationGaps = computeNarrationGaps(voice.words);

  // 6b. Director cinematográfico (solo si el worker lo decidió: CINEMATIC_DIRECTOR_RENDER_ENABLED + cuenta piloto + Reel visual;
  // en cualquier otro caso, flujo idéntico al anterior).
  // Las recetas ordenan el material YA resuelto (movimiento, transiciones, etiqueta por plano). El plan, las
  // props y la tabla por plano se guardan junto al MP4. Si el plan no se puede montar sin inventar material,
  // el render se detiene con un error explícito: nunca cae en silencio al montaje sin Director.
  let renderScenes = scenes;
  let renderCaptions = captions;
  if (directorRender && cinematicDirectorRenderEnabled()) {
    const { directReel, directorBlockMessage } = await import("@/lib/video/director/reel-render");
    let directed = directReel({ script, storyboard, beatsBySegment: directorBeats, sceneTimings, audioUrl, captions, narrationGaps, durationSeconds: finalDurationSeconds, adapter: directorAdapter });
    // Anexo C1: the plan lacks material only (no licence/policy/timing issue) and the owner approved a ceiling for
    // this production → generate exactly those shots with the gated image call, then re-plan ONCE. Over the ceiling
    // → stop here, before any new paid call (DirectorMaterialBudgetError carries the delta).
    let fill: { approvedUsd: number; spentUsd: number; shots: string[]; reusedShots: string[] } | { approvedUsd: number; skipped: string } | null = null;
    const materialBudget = !directed.ok && directorMaterialBudgetUsd ? await directorMaterialBudgetUsd() : 0;
    // D-RETRY-CEILING: an owner test runs the fill even with a 0 ceiling, so a retry whose shots are ALL already
    // stored completes without new spend; anything new over the confirmed ceiling stops before the provider.
    if (!directed.ok && directorMaterialBudgetUsd) {
      const { fillDirectorMaterial, fillObjectKey, fillPrompt } = await import("@/lib/video/director/material-fill");
      const { imageVariant } = await import("@/lib/video/image-pricing");
      const { simulateStoryboard } = await import("@/lib/video/storyboard/simulate");
      const sb = storyboard ?? simulateStoryboard(script);
      const sbScenes = [...sb.scenes].sort((x, y) => x.order - y.order);
      const fillProvider = imageProvider ?? getImageProvider();
      const { findExistingGeneratedImage } = await import("@/lib/video/visual-resource-resolver");
      const keyOf = (shot: Parameters<typeof fillObjectKey>[0], sceneIndex: number) => {
        const base = sbScenes[sceneIndex];
        return fillObjectKey(shot, fillPrompt(base.imagePrompt, shot), base.negativePrompt, imageVariant(fillProvider.name));
      };
      const result = await fillDirectorMaterial({
        directed, approvedUsd: materialBudget, beatsBySegment: directorBeats, sceneTimings,
        isStored: async (shot, sceneIndex) => Boolean(await findExistingGeneratedImage(supabase, STORAGE_BUCKET, requestId, sceneIndex, keyOf(shot, sceneIndex))),
        generate: async (shot, sceneIndex, maxUsd) => {
          const base = sbScenes[sceneIndex];
          const prompt = fillPrompt(base.imagePrompt, shot);
          const generated = await resolveGeneratedImageForScene({
            ledger: gate.ledger, supabase, bucket: STORAGE_BUCKET, requestId, sceneIndex,
            scene: { ...base, imagePrompt: prompt },
            imageProvider: fillProvider, remainingBudgetUsd: maxUsd, signedUrlTtlSeconds: ASSET_SIGNED_URL_TTL_SECONDS,
            // P1: the key follows the content (prompt, sentence, model), never only the shot id.
            objectKey: fillObjectKey(shot, prompt, base.negativePrompt, imageVariant(fillProvider.name)),
          });
          storageBytes += generated.bufferBytes;
          visualCostSpentUsd += generated.costUsd;
          if (generated.status === "generated") imagesGeneratedCount += 1; else imagesReusedCount += 1;
          console.log("[atomivid:director-fill]", JSON.stringify({ requestId, shot: shot.shotId, status: generated.status, provider: generated.provider, costUsd: generated.costUsd }));
          return { url: generated.url, costUsd: generated.costUsd };
        },
      });
      if ("skipped" in result) fill = { approvedUsd: materialBudget, skipped: result.skipped };
      else {
        fill = { approvedUsd: materialBudget, spentUsd: result.spentUsd, shots: result.shots.map(s => s.shotId), reusedShots: result.reusedShots };
        directed = directReel({ script, storyboard, beatsBySegment: result.beatsBySegment, sceneTimings, audioUrl, captions, narrationGaps, durationSeconds: finalDurationSeconds, adapter: directorAdapter });
      }
    }
    const evidence = Buffer.from(JSON.stringify({
      // T-34 B3: binds the record to THIS attempt's MP4 (same prefix) and its real duration; the video page checks both.
      artifactPrefix, durationSeconds: finalDurationSeconds,
      footageSelections,
      ok: directed.ok, storyboardSource: directed.storyboardSource, input: directed.input, plan: directed.plan,
      ...(fill ? { materialFill: fill } : {}),
      ...(directed.ok ? { applied: directed.applied, props: directed.props } : { blockers: directed.blockers }),
    }, null, 2));
    await uploadToStorage(supabase, `${artifactPrefix}/director.json`, evidence, "application/json");
    console.log("[atomivid:director]", JSON.stringify({ requestId, ok: directed.ok, shots: directed.ok ? directed.applied.map(a => ({ shot: a.shotId, recipe: a.recipeId, motion: a.applied.motion, in: a.applied.transitionIn, out: a.applied.transitionOut, label: a.applied.label })) : undefined, blockers: directed.ok ? undefined : directed.blockers.map(b => b.code) }));
    if (!directed.ok) throw new Error(directorBlockMessage(directed.blockers));
    renderScenes = directed.props.scenes;
    renderCaptions = directed.props.captions;
  }

  // 7. Ensamblar el video final con Remotion
  await onProgress?.("render");
  const renderStartedAt = Date.now();
  const rawOutputPath = await renderVerticalReel({
    audioUrl,
    musicUrl,
    scenes: renderScenes,
    captions: renderCaptions,
    narrationGaps,
    durationSeconds: finalDurationSeconds,
  });
  const renderMs = Date.now() - renderStartedAt;

  // 7b. Masterizar el loudness del archivo final — causa raíz confirmada
  // de "la mezcla general está demasiado baja para redes sociales"
  // (audio-master.ts). Si ffmpeg no está disponible (p. ej. en desarrollo
  // local sin instalarlo), se sube el archivo sin masterizar en vez de
  // tumbar todo el render — se advierte claramente, nunca en silencio.
  let outputPath = rawOutputPath;
  try {
    const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
    // F3 (T-20261019-1602): el MP4 corto también lleva moov al inicio — se reproduce y descarga de forma progresiva sin bajar el archivo entero.
    const mastering = await masterAudioLoudness(rawOutputPath, masteredPath, { faststart: true });
    outputPath = masteredPath;
    console.log(
      "[atomivid:audio] masterización de loudness",
      JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }),
    );
  } catch (err) {
      if (err instanceof SupplyUnavailableError) throw err;
    console.warn(
      `[atomivid:audio] ${requestId} — no se pudo masterizar el loudness (¿falta ffmpeg?), ` +
        "se sube el video sin normalizar:",
      err instanceof Error ? err.message : err,
    );
  }

  // 8. Subir el video renderizado (se referencia por su ruta; la URL para
  // verlo/descargarlo se firma bajo demanda, después de validar dueño).
  await onProgress?.("uploading");
  // Control de costos (2026-10-18): only a playable file may become «completed».
  await verifyDeliverableMp4(outputPath, { minSeconds: voice.durationSeconds * 0.5 });
  const videoBuffer = await fs.readFile(outputPath);
  storageBytes += videoBuffer.byteLength;
  const { path: videoPath } = await uploadToStorage(
    supabase,
    `${artifactPrefix}/final.mp4`,
    videoBuffer,
    "video/mp4",
  );
  await fs.unlink(outputPath).catch(() => {});
  if (outputPath !== rawOutputPath) {
    await fs.unlink(rawOutputPath).catch(() => {});
  }

  // Costo estimado de esta etapa — no bloquea el resultado si falla (es
  // instrumentación, no debe tumbar un video que sí se generó bien).
  await recordVideoGeneration(supabase, requestId, {
    voiceProvider: voiceProvider.name,
    voiceCharacters: fullText.length,
    footageProvider: footageProvider.name,
    footageCount: scenes.length,
    // "none" dice explícitamente que el video se generó sin música por un
    // fallback (no confundir con "no se registró" — ver musicFallbackReason
    // en los logs de arriba para la causa exacta).
    musicProvider: music ? musicProvider.name : "none",
    musicTrack: music?.track
      ? {
          id: music.track.trackId,
          title: music.track.title,
          author: music.track.author,
          license: music.track.license,
          sourceUrl: music.track.sourceUrl,
        }
      : null,
    musicFallbackReason,
    videoDurationSeconds: finalDurationSeconds,
    renderMs,
    storageBytes,
    creativeLayer:
      imagesRequestedCount > 0
        ? {
            imageProvider: usedGeneratedImageProvider ?? undefined,
            imageGenerationCount: imagesGeneratedCount,
            imageCostUsd: visualCostSpentUsd,
            imageRequestedCount: imagesRequestedCount,
            imageReusedCount: imagesReusedCount,
            imageDryRun: false,
            imageModel: usedGeneratedImageModel ?? undefined,
            imageSize: usedGeneratedImageSize ?? undefined,
          }
        : undefined,
  }).catch((err) => {
    console.warn(`No se pudo registrar el costo de ${requestId}:`, err);
  });

  return { videoPath };
}

/**
 * Sube un archivo al bucket privado y devuelve tanto su ruta (para
 * guardarla y firmar una URL nueva más adelante) como una URL firmada de
 * corta duración (para que este mismo proceso de render pueda leerlo de
 * inmediato, p. ej. Remotion descargando una imagen o un audio).
 */
async function uploadToStorage(
  supabase: SupabaseClient,
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ path: string; url: string }> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true });

  if (error) {
    throw new Error(`No se pudo subir ${objectPath}: ${error.message}`);
  }

  const { data, error: signError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(objectPath, ASSET_SIGNED_URL_TTL_SECONDS);

  if (signError || !data) {
    throw new Error(
      `No se pudo firmar la URL de ${objectPath}: ${signError?.message ?? "desconocido"}`,
    );
  }

  return { path: objectPath, url: data.signedUrl };
}

async function renderVerticalReel({
  audioUrl,
  musicUrl,
  scenes,
  captions,
  narrationGaps,
  durationSeconds,
}: {
  audioUrl: string;
  musicUrl?: string;
  scenes: Scene[];
  captions: Caption[];
  narrationGaps: NarrationGap[];
  durationSeconds: number;
}): Promise<string> {
  const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  // Chrome >= 132 quitó el "old headless mode" que Remotion usa por
  // defecto. Si apuntas REMOTION_BROWSER_EXECUTABLE a un chrome-headless-shell
  // (recomendado), configura también REMOTION_CHROME_MODE=headless-shell.
  const chromeMode =
    (process.env.REMOTION_CHROME_MODE as "chrome-for-testing" | "headless-shell" | undefined) ||
    undefined;

  const serveUrl = await bundle({ entryPoint });

  const inputProps = {
    audioUrl,
    musicUrl,
    scenes,
    captions,
    narrationGaps,
    durationSeconds,
    accentColor: getAccentColor(),
    showLogo: shouldShowLogo(),
  };

  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    browserExecutable,
    chromeMode,
  });

  const outputLocation = path.join(
    os.tmpdir(),
    `atomivid-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation,
    inputProps,
    browserExecutable,
    chromeMode,
    // Sin esto, Remotion usa un CRF cercano a sin-pérdida por defecto — con
    // fotos reales (no los placeholders planos del fixture) y Ken Burns,
    // eso produce archivos varias veces más grandes de lo necesario para
    // un reel vertical (llegó a exceder el límite de tamaño de Supabase
    // Storage). CRF 26 es suficiente para TikTok/Reels/Shorts, que de
    // todas formas re-comprimen el video al subirlo.
    crf: 26,
  });

  return outputLocation;
}
