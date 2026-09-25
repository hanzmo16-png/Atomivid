/**
 * Recuperación de una producción Long Form cuyo render terminó pero cuya
 * ENTREGA falló (P0 2026-09-25, Canal de Panamá: final.mp4 rechazado por
 * tamaño). Reconstruye el video EXCLUSIVAMENTE desde lo ya persistido —
 * narración del caché TTS durable, assets por escena ya pagados, música ya
 * subida del intento original — con CERO llamadas a proveedores.
 *
 * Garantía por construcción (no por convención):
 * - Los proveedores de voz/archivo/imagen son stubs que LANZAN si se les
 *   llama (PaidCallForbiddenError); no hay claves de ElevenLabs, OpenAI,
 *   Pexels, Veo ni Anthropic en el entorno del workflow.
 * - produce.ts corre en `replayOnly`: narración solo desde caché, escenas
 *   solo desde registros COMPLETED; cualquier faltante o desviación de lo
 *   ya ejecutado aborta ANTES de renderizar.
 *
 * MODE:
 * - verify (por defecto): reconstruye timeline + escenas y verifica que TODO
 *   está en caché. No renderiza, no escribe nada (stores de solo lectura).
 * - measure_legacy: como verify + render con el perfil ANTERIOR (CRF 26)
 *   para medir el equivalente del MP4 original. No sube ni escribe nada.
 * - render: render con el perfil v1 + entrega canónica (preflight de tamaño,
 *   subida reanudable, estado durable) + fila a "completed" con CAS desde
 *   "failed". Registra costos una sola vez (upsert).
 *
 * Uso (GitHub Actions: recover-long-form-output.yml):
 *   REQUEST_ID=<uuid> MODE=verify npx tsx scripts/recover-long-form-output.ts
 */
export {};

class PaidCallForbiddenError extends Error {
  constructor(what: string) {
    super(`LLAMADA A PROVEEDOR PROHIBIDA en recuperación: ${what}`);
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
  const { supabaseOutputDeps, canonicalOutputPath } = await import("../src/lib/video/long-form/output-finalize");
  const { probeOutput } = await import("../src/lib/video/long-form/output-media");
  const { estimateOutputBytes, LONG_FORM_ENCODING_PROFILE, LONG_FORM_OUTPUT_POLICY } = await import("../src/lib/video/long-form/output-policy");

  const requestId = process.env.REQUEST_ID;
  const mode = (process.env.MODE ?? "verify") as "verify" | "measure_legacy" | "render";
  if (!requestId) throw new Error("REQUEST_ID requerido");
  if (!["verify", "measure_legacy", "render"].includes(mode)) throw new Error(`MODE inválido: ${mode}`);
  for (const key of ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "PEXELS_API_KEY", "VEO_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (process.env[key]) throw new Error(`${key} presente en el entorno — la recuperación debe correr SIN credenciales de proveedores.`);
  }
  const artifactDir = process.env.RECOVERY_ARTIFACT_DIR ?? path.join(process.cwd(), "recovery-artifacts");
  await fs.mkdir(artifactDir, { recursive: true });

  const service = createServiceClient();
  const bucket = "videos";
  const report: Record<string, unknown> = { requestId, mode, startedAtIso: new Date().toISOString() };
  const t0 = Date.now();

  const { data: row, error } = await service
    .from("video_requests")
    .select("id,status,mode,language,render_attempts,script_json,long_form_production_plan,long_form_confirmed_at,video_path,error_message")
    .eq("id", requestId)
    .single();
  if (error || !row) throw new Error(`request_read_failed: ${error?.message ?? "no existe"}`);
  if (row.mode !== "long_form") throw new Error(`no es long_form (${row.mode})`);
  if (!isLongFormScriptJson(row.script_json)) throw new Error("script_json inválido");
  const script = row.script_json as unknown as { topic: string; beats: { id: string; type: string; narration: string; visuals?: unknown }[] };
  const plan = resolveExecutablePlan({ confirmedAt: row.long_form_confirmed_at, plan: row.long_form_production_plan, beats: script.beats as never });
  report.request = { status: row.status, render_attempts: row.render_attempts, video_path: row.video_path, planShotCount: plan.shotCount, planDurationSeconds: plan.durationSeconds };
  if (mode === "render" && row.status !== "failed") throw new Error(`MODE=render exige status "failed" (está en "${row.status}") — no se toca una solicitud activa o completada.`);

  // --- Proveedores prohibidos (mismos NOMBRES que en la ejecución original:
  // la clave del caché TTS incluye el nombre del proveedor de voz) ---
  const calls = { voice: 0, footage: 0, image: 0 };
  const forbidden = (what: keyof typeof calls, label: string) => () => {
    calls[what] += 1;
    throw new PaidCallForbiddenError(label);
  };
  const voiceProvider = { name: "elevenlabs", synthesize: forbidden("voice", "ElevenLabs.synthesize") };
  const footageProvider = {
    name: "pexels-video-first",
    fetchFootage: forbidden("footage", "Pexels.fetchFootage"),
    searchImageCandidates: forbidden("footage", "Pexels.searchImageCandidates"),
    searchVideoCandidates: forbidden("footage", "Pexels.searchVideoCandidates"),
    downloadFootage: forbidden("footage", "Pexels.downloadFootage"),
  };
  const imageProvider = {
    name: "openai",
    capabilities: { id: "openai", models: [], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => false,
    generateImage: forbidden("image", "OpenAI.generateImage"),
  };
  // Música: la MISMA pista ya subida en el intento original (sin volver a descargarla de la biblioteca).
  const attempt = row.render_attempts as number;
  const storedMusicPath = `${requestId}/attempt-${attempt}/music.mp3`;
  const musicProvider = {
    name: "curated-library",
    async getTrack() {
      const { data, error: dlError } = await service.storage.from(bucket).download(storedMusicPath);
      if (dlError || !data) throw new Error(`música original no encontrada (${storedMusicPath})`);
      return { audioBuffer: Buffer.from(await data.arrayBuffer()), mimeType: "audio/mpeg", extension: "mp3" };
    },
  };

  // --- Stores: de solo lectura salvo en MODE=render ---
  const realShotStore = supabaseShotAssetStore(service, requestId, bucket);
  const readOnly = mode !== "render";
  const writes: string[] = [];
  const shotStore = readOnly
    ? {
        ...realShotStore,
        async write(r: { shotId: string }) {
          writes.push(`shot:${r.shotId}`);
          throw new Error("escritura prohibida en modo solo lectura");
        },
        async putObject(p: string) {
          writes.push(`object:${p}`);
          throw new Error("escritura prohibida en modo solo lectura");
        },
      }
    : realShotStore;
  const realBudgetStore = supabaseBudgetStore(service, requestId, bucket);
  const budgetStore = readOnly ? { load: realBudgetStore.load, save: async () => {} } : realBudgetStore;
  const budgetBefore = await realBudgetStore.load();

  const realOutput = supabaseOutputDeps(service);
  let renderedCopy: string | null = null;
  let deliveredCopy: string | null = null;
  const copyTo = async (src: string, name: string) => {
    const target = path.join(artifactDir, name);
    await fs.copyFile(src, target);
    return target;
  };
  const outputDeps = readOnly
    ? {
        ...realOutput,
        // measure_legacy/verify: nunca suben ni escriben estado.
        readState: async () => null,
        objectSize: async () => null,
        writeState: async () => {},
        upload: async (_objectPath: string, filePath: string) => {
          deliveredCopy = await copyTo(filePath, "measured.mp4");
          return { method: "standard" as const, attempts: [] };
        },
        storageMaxBytes: null,
      }
    : {
        ...realOutput,
        probe: async (filePath: string) => {
          if (!renderedCopy) renderedCopy = await copyTo(filePath, "rendered.mp4");
          return probeOutput(filePath);
        },
        upload: async (objectPath: string, filePath: string) => {
          deliveredCopy = await copyTo(filePath, "delivered.mp4");
          return realOutput.upload(objectPath, filePath);
        },
      };

  // --- Probe exacto del límite (solo verify) ---
  if (mode === "verify" && process.env.PROBE_EXACT_LIMIT === "true") {
    const probes: { bytes: number; ok: boolean; error?: string }[] = [];
    for (const bytes of [50 * 1024 * 1024, 50 * 1024 * 1024 + 1]) {
      const p = `_diagnostics/size-probe/${Date.now()}-${bytes}.bin`;
      const { error: upErr } = await service.storage.from(bucket).upload(p, Buffer.alloc(bytes), { contentType: "application/octet-stream", upsert: true });
      probes.push({ bytes, ok: !upErr, error: upErr?.message });
      if (!upErr) await service.storage.from(bucket).remove([p]);
    }
    report.exactLimitProbe = probes;
  }

  // --- Ejecución ---
  const phases: Record<string, number> = {};
  let phase = "start";
  let phaseStart = Date.now();
  let renderInputSummary: Record<string, unknown> | null = null;
  const STOP = "__VERIFY_STOP__";
  let result: Awaited<ReturnType<typeof generateLongFormVideoFromScript>> | null = null;
  try {
    result = await generateLongFormVideoFromScript({
      supabase: service,
      requestId,
      // Objetos de trabajo (voz/música para Remotion) en carpetas separadas por
      // modo: nunca sobrescriben el intento original ni entre corridas paralelas.
      artifactPrefix: `${requestId}/recovery${mode === "measure_legacy" ? "-measure" : ""}`,
      topic: script.topic,
      beats: script.beats as never,
      language: (row.language as "es" | "en" | null) ?? undefined,
      plan,
      providers: { voiceProvider, footageProvider, imageProvider, musicProvider } as never,
      onProgress: (stage) => {
        if (stage !== phase) {
          phases[phase] = (phases[phase] ?? 0) + (Date.now() - phaseStart);
          phase = stage;
          phaseStart = Date.now();
        }
      },
      runtime: {
        replayOnly: true,
        store: shotStore as never,
        budgetStore: budgetStore as never,
        videoProvider: null,
        attempt,
        output: outputDeps as never,
        encoding: mode === "measure_legacy" ? "legacy_crf26" : "long_form_h264_v1",
        recordCosts: mode === "render",
        // measure_legacy SÍ necesita URLs reales de voz/música para Remotion:
        // se suben como objetos de trabajo bajo `${requestId}/recovery/`
        // (nunca sobrescriben el intento original). verify no sube nada.
        ...(mode === "verify"
          ? {
              uploadArtifact: async (p: string) => ({ path: p, url: `about:blank#${p}` }),
              render: async (input: import("../src/lib/video/long-form/render").RenderLongFormDocInput) => {
                renderInputSummary = {
                  scenes: input.scenes.length,
                  durationSeconds: input.durationSeconds,
                  frames: Math.round(input.durationSeconds * LONG_FORM_ENCODING_PROFILE.fps),
                  mediaScenes: input.scenes.filter((s) => s.asset.kind === "media").length,
                  textScenes: input.scenes.filter((s) => s.asset.kind !== "media").length,
                  captions: input.captions.length,
                };
                throw new Error(STOP);
              },
            }
          : {}),
      },
    });
  } catch (err) {
    if (!(err instanceof Error && err.message === STOP)) {
      report.error = { name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) };
    }
  }
  phases[phase] = (phases[phase] ?? 0) + (Date.now() - phaseStart);
  report.phasesMs = phases;
  report.renderInput = renderInputSummary;
  report.providerCalls = calls;
  report.newPaidProviderCalls = calls.voice + calls.image + calls.footage;
  report.readOnlyWriteAttempts = writes;
  const budgetAfter = await realBudgetStore.load();
  report.budgetUnchanged = JSON.stringify(budgetBefore?.used) === JSON.stringify(budgetAfter?.used);
  report.budgetUsed = budgetAfter?.used ?? null;

  if (result) {
    report.result = { videoPath: result.videoPath, reconciled: result.reconciled, spentUsd: result.spentUsd, deviations: result.deviations, output: result.output };
  }
  if (renderedCopy) report.renderedMetrics = await probeOutput(renderedCopy);
  if (deliveredCopy) report.deliveredMetrics = await probeOutput(deliveredCopy);

  if (mode === "render" && result && !report.error) {
    const { data: updated, error: updError } = await service
      .from("video_requests")
      .update({ status: "completed", video_path: result.videoPath, error_message: null, progress_stage: null, long_form_stage: null, long_form_progress: null })
      .eq("id", requestId)
      .eq("status", "failed")
      .eq("render_attempts", attempt)
      .select("id,status,video_path")
      .maybeSingle();
    report.rowUpdate = updError ? { error: updError.message } : updated;
    report.canonicalPath = canonicalOutputPath(requestId);
  }

  report.policy = {
    profile: LONG_FORM_ENCODING_PROFILE,
    policyMaxBytes: LONG_FORM_OUTPUT_POLICY.policyMaxBytes,
    estimates: [180, 300, 600, 900].map((s) => estimateOutputBytes(s)),
  };
  report.totalMs = Date.now() - t0;

  console.log("===RECOVERY_JSON_BEGIN===");
  console.log(JSON.stringify(report, null, 2));
  console.log("===RECOVERY_JSON_END===");
  if (report.error || report.newPaidProviderCalls !== 0 || writes.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("recovery_failed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
