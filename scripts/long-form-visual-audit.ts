/**
 * Auditoría de diversidad/coherencia visual de una producción Long Form YA
 * hecha (calidad visual M1) — SOLO LECTURA, CERO proveedores:
 *
 * 1. Reconstruye, desde lo persistido (caché TTS + registros por escena),
 *    exactamente las escenas del documental original (replayOnly, como la
 *    recuperación P0) y genera el informe visual previo al render.
 * 2. Descarga cada recurso guardado y calcula su identidad de contenido
 *    (SHA-256 + hash perceptual) — los registros anteriores a v3 no la
 *    traen — para detectar repeticiones REALES.
 * 3. Simula la muestra inicial (≤ 60 s) con el pipeline v3 (escenas
 *    ancladas a la narración + selección con identidad de contenido)
 *    usando SOLO los recursos ya existentes de esta solicitud: muestra qué
 *    escenas quedarían cubiertas y qué carencias exigirían recursos nuevos.
 *
 * Nunca escribe en la base de datos ni en Storage; los proveedores son
 * stubs que lanzan si se les llama; el workflow no recibe claves.
 */
export {};

class PaidCallForbiddenError extends Error {
  constructor(what: string) {
    super(`LLAMADA A PROVEEDOR PROHIBIDA en auditoría: ${what}`);
    this.name = "PaidCallForbiddenError";
  }
}

async function main() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { generateLongFormVideoFromScript } = await import("../src/lib/video/long-form/produce");
  const { resolveExecutablePlan } = await import("../src/lib/video/long-form/production-plan");
  const { isLongFormScriptJson } = await import("../src/lib/video/long-form/script-json");
  const { supabaseShotAssetStore } = await import("../src/lib/video/long-form/durable-shot-assets");
  const { supabaseBudgetStore } = await import("../src/lib/video/long-form/production-budget");
  const { contentIdentity, DocumentAssetRegistry } = await import("../src/lib/video/long-form/asset-identity");
  const { applyIdentities } = await import("../src/lib/video/long-form/visual-report");
  const { loadProductionCachedBeatNarration } = await import("../src/lib/video/long-form/production-tts-cache");
  const { getVoiceIdentity } = await import("../src/lib/ai/voice");
  const { shotsForSpan } = await import("../src/lib/video/long-form/shots");
  const { visualsForBeat } = await import("../src/lib/video/long-form/visual-intents");
  const { selectStockForShot, englishTerms } = await import("../src/lib/video/long-form/stock-selection");
  type VisualReport = import("../src/lib/video/long-form/visual-report").VisualReport;
  type AssetIdentity = import("../src/lib/video/long-form/asset-identity").AssetIdentity;

  const requestId = process.env.REQUEST_ID;
  if (!requestId) throw new Error("REQUEST_ID requerido");
  for (const key of ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "PEXELS_API_KEY", "VEO_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (process.env[key]) throw new Error(`${key} presente — la auditoría corre SIN credenciales de proveedores.`);
  }
  const outDir = process.env.AUDIT_ARTIFACT_DIR ?? path.join(process.cwd(), "visual-audit");
  await fs.mkdir(outDir, { recursive: true });
  const service = createServiceClient();
  const bucket = "videos";

  const { data: row, error } = await service
    .from("video_requests")
    .select("id,mode,language,script_json,long_form_production_plan,long_form_confirmed_at")
    .eq("id", requestId)
    .single();
  if (error || !row) throw new Error(`request_read_failed: ${error?.message ?? "no existe"}`);
  if (!isLongFormScriptJson(row.script_json)) throw new Error("script_json inválido");
  const script = row.script_json as unknown as { topic: string; beats: { id: string; type: string; narration: string; visuals?: unknown }[] };
  const plan = resolveExecutablePlan({ confirmedAt: row.long_form_confirmed_at, plan: row.long_form_production_plan, beats: script.beats as never });
  const language = ((row.language as "es" | "en" | null) ?? "es") as "es" | "en";

  // --- 1) Réplica del documental original (solo lectura) ---
  const calls = { voice: 0, footage: 0, image: 0 };
  const forbidden = (what: keyof typeof calls, label: string) => () => {
    calls[what] += 1;
    throw new PaidCallForbiddenError(label);
  };
  const providers = {
    voiceProvider: { name: "elevenlabs", synthesize: forbidden("voice", "ElevenLabs") },
    footageProvider: {
      name: "pexels-video-first",
      fetchFootage: forbidden("footage", "Pexels"),
      searchImageCandidates: forbidden("footage", "Pexels"),
      downloadFootage: forbidden("footage", "Pexels"),
    },
    imageProvider: {
      name: "openai",
      capabilities: { id: "openai", models: [], formats: [], aspectRatios: [], timeoutMs: 1, maxRetries: 0 },
      isAvailable: () => false,
      generateImage: forbidden("image", "OpenAI"),
    },
    musicProvider: { name: "curated-library", getTrack: async () => ({ audioBuffer: Buffer.from("x"), mimeType: "audio/mpeg", extension: "mp3" }) },
  };
  const realStore = supabaseShotAssetStore(service, requestId, bucket);
  const readOnlyStore = {
    ...realStore,
    write: async () => {
      throw new Error("escritura prohibida");
    },
    putObject: async () => {
      throw new Error("escritura prohibida");
    },
  };
  const realBudget = supabaseBudgetStore(service, requestId, bucket);
  let legacyReport: VisualReport | null = null;
  const STOP = "__AUDIT_STOP__";
  try {
    await generateLongFormVideoFromScript({
      supabase: service,
      requestId,
      topic: script.topic,
      beats: script.beats as never,
      language,
      plan,
      providers: providers as never,
      runtime: {
        replayOnly: true,
        store: readOnlyStore as never,
        budgetStore: { load: realBudget.load, save: async () => {} } as never,
        videoProvider: null,
        recordCosts: false,
        uploadArtifact: async (p: string) => ({ path: p, url: `about:blank#${p}` }),
        // La salida ya existe (Panamá completado): la auditoría NO debe reconciliar, debe re-armar las escenas.
        output: {
          readState: async () => null,
          objectSize: async () => null,
        } as never,
        saveVisualReport: async (report) => {
          legacyReport = report;
        },
        render: async () => {
          throw new Error(STOP);
        },
      },
    });
  } catch (err) {
    if (!(err instanceof Error && err.message === STOP)) throw err;
  }
  if (!legacyReport) throw new Error("no se generó el informe del documental original");
  const original = legacyReport as VisualReport;

  // --- 2) Identidad de contenido de cada recurso guardado ---
  const identities = new Map<string, AssetIdentity>();
  const media = original.scenes.filter((s) => s.display !== "card" && s.assetRef);
  for (let i = 0; i < media.length; i += 4) {
    await Promise.all(
      media.slice(i, i + 4).map(async (scene) => {
        const { data } = await service.storage.from(bucket).download(scene.assetRef as string);
        if (!data) return;
        const buffer = Buffer.from(await data.arrayBuffer());
        identities.set(scene.shotId, await contentIdentity(buffer, scene.display === "video" ? "video" : "image"));
      }),
    );
  }
  const audited = applyIdentities(original, identities);

  // --- 3) Muestra inicial (≤ 60 s) con el pipeline v3 y SOLO recursos existentes ---
  const voiceIdentity = getVoiceIdentity(language === "en" ? "en" : "es");
  const openingShots: import("../src/lib/video/long-form/types").Shot[] = [];
  let cursor = 0;
  for (const [index, beat] of script.beats.entries()) {
    if (cursor >= 60) break;
    const narrated = await loadProductionCachedBeatNarration(service, "elevenlabs", beat, language, { videoId: requestId, voiceIdentity });
    const shots = shotsForSpan({
      beatId: beat.id,
      beatType: beat.type as never,
      startSec: cursor,
      endSec: cursor + narrated.durationSeconds,
      narration: beat.narration,
      typeOffset: index * 2,
      strategy: plan.strategy,
      visuals: visualsForBeat(beat, script.topic),
      anchoring: { words: narrated.words },
    });
    openingShots.push(...shots.filter((s) => s.startSec < 60));
    cursor += narrated.durationSeconds;
  }
  // Catálogo = recursos YA existentes de esta solicitud (únicos por contenido), descritos por la búsqueda que los trajo.
  const pool = new Map<string, { sha: string; scene: (typeof original.scenes)[number]; identity: AssetIdentity }>();
  for (const scene of media) {
    const identity = identities.get(scene.shotId);
    if (identity?.sha256 && !pool.has(identity.sha256)) pool.set(identity.sha256, { sha: identity.sha256, scene, identity });
  }
  const poolProvider = {
    name: "existing-assets",
    fetchFootage: async () => {
      throw new Error("no aplica");
    },
    async searchImageCandidates(query: string) {
      const q = new Set(englishTerms(query));
      return [...pool.values()]
        .map((p) => ({ p, overlap: englishTerms(p.scene.intent.description).filter((t) => q.has(t)).length }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 12)
        .map(({ p }) => ({
          url: `existing://${p.sha}`,
          sourceId: p.sha,
          description: p.scene.intent.description,
          mediaType: p.scene.display === "video" ? ("video" as const) : ("image" as const),
          mimeType: "application/octet-stream",
          extension: "bin",
        }));
    },
    downloadFootage: async (url: string) => Buffer.from(url.replace("existing://", "")),
  };
  const registry = new DocumentAssetRegistry();
  const sample: Record<string, unknown>[] = [];
  for (const shot of openingShots) {
    const legacyScene = original.scenes.find((s) => s.startSec <= shot.startSec + 0.01 && s.endSec > shot.startSec + 0.01);
    const base = {
      shotId: shot.id,
      startSec: shot.startSec,
      endSec: shot.endSec,
      narrationFragment: shot.narrationFragment,
      v3Intent: shot.visualIntent,
      anchoredBy: shot.intentAnchor?.anchoredBy,
      v3Type: shot.type,
      originalIntent: legacyScene?.intent.description,
      originalAsset: legacyScene?.assetRef,
    };
    if (shot.type === "text") {
      sample.push({ ...base, outcome: "tarjeta con dato", detail: shot.narrationFragment });
      continue;
    }
    const outcome = await selectStockForShot(
      { shotId: shot.id, visual: shot.anchoredVisual ?? { description: shot.visualIntent, motion: false }, preferVideo: shot.type === "stock_video", minDurationSec: 0 },
      {
        footageProvider: poolProvider as never,
        registry,
        identify: async (buffer) => {
          const p = pool.get(buffer.toString());
          return { sha256: p?.sha, dhash: p?.identity.dhash };
        },
      },
    );
    if (outcome.status === "selected") {
      registry.register(shot.id, outcome.identity);
      const p = pool.get(outcome.identity.sha256 as string);
      sample.push({
        ...base,
        outcome: "recurso existente",
        asset: p?.scene.assetRef,
        provenance: p?.scene.provenance,
        assetOriginalQuery: outcome.candidate.description,
        relevance: outcome.assessment.relevance,
        matchedTerms: outcome.assessment.matchedTerms,
      });
    } else {
      sample.push({
        ...base,
        outcome: "CARENCIA",
        detail: outcome.reason,
        needs: shot.type === "generated_placeholder" ? "imagen IA nueva (pagada)" : "búsqueda nueva de archivo (Pexels, sin costo)",
      });
    }
  }

  const summary = {
    requestId,
    planVersion: plan.version,
    providerCalls: calls,
    original: {
      scenes: audited.summary.scenes,
      mediaScenes: audited.summary.mediaScenes,
      uniqueAssets: audited.summary.uniqueAssets,
      repeatedGroups: audited.summary.repeatedAssets.length,
      repeatedAssets: audited.summary.repeatedAssets,
      coverageSeconds: audited.summary.coverageSeconds,
      titleCards: audited.summary.titleCards.length,
      openingWindow: audited.summary.openingWindow,
      uncertainScenes: audited.summary.uncertainScenes.length,
      intentReuse: Object.entries(
        audited.scenes.reduce<Record<string, number>>((acc, s) => {
          acc[s.intent.description] = (acc[s.intent.description] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      dhashUnavailable: [...identities.values()].filter((i) => !i.dhash).length,
    },
    v3OpeningSample: {
      scenes: sample.length,
      coveredByExistingAssets: sample.filter((s) => s.outcome === "recurso existente").length,
      factCards: sample.filter((s) => s.outcome === "tarjeta con dato").length,
      gaps: sample.filter((s) => s.outcome === "CARENCIA").length,
    },
  };
  await fs.writeFile(path.join(outDir, "original-report.json"), JSON.stringify(audited, null, 2));
  await fs.writeFile(path.join(outDir, "v3-opening-sample.json"), JSON.stringify(sample, null, 2));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("===AUDIT_SUMMARY_BEGIN===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("===AUDIT_SUMMARY_END===");
  console.log("===ORIGINAL_SCENES_BEGIN===");
  for (const s of audited.scenes) {
    console.log(
      JSON.stringify({
        id: s.shotId,
        t: `${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}`,
        type: s.executedType,
        intent: s.intent.description,
        asset: s.assetRef?.split("/").pop(),
        sha: s.assetRef ? identities.get(s.shotId)?.sha256?.slice(0, 10) : undefined,
        card: s.cardTitle,
      }),
    );
  }
  console.log("===ORIGINAL_SCENES_END===");
  console.log("===V3_SAMPLE_BEGIN===");
  for (const s of sample) console.log(JSON.stringify(s));
  console.log("===V3_SAMPLE_END===");
  if (calls.voice + calls.footage + calls.image > 0) process.exit(1);
}

main().catch((err) => {
  console.error("audit_failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
