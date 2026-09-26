/**
 * Muestras REALES de la dirección audiovisual (Reels). PREPARADO, NO
 * EJECUTADO: requiere presupuesto autorizado por Hans.
 *
 * Modos (variable MODE):
 *  - plan (por defecto): no llama a ningún proveedor. Imprime el plan, la
 *    estimación por muestra, lo ya comprometido en los registros durables
 *    (si hay credenciales de Supabase, solo lectura) y si cada muestra
 *    cabe en su tope.
 *  - run: exige SAMPLE_ALLOW_PAID=true. Por cada muestra seleccionada, en
 *    serie y DETENIÉNDOSE ante el primer fallo (sample-runner.ts):
 *      1. RELEE el comprometido de todos los registros durables y recalcula
 *         la decisión y el tope efectivo = min(tope por muestra, total −
 *         comprometido por las demás) justo antes de la muestra (el plan
 *         impreso al inicio es solo informativo);
 *      2. abre su registro de gasto durable (samples/audiovisual/<id>/state/paid-ledger.json)
 *         con ese tope;
 *      3. guion (Claude) una sola vez, guardado y reutilizado en reintentos;
 *         CADA llamada real (borrador, correcciones de longitud, reintentos
 *         permitidos) se reserva y liquida en el registro con sus tokens
 *         medidos (script-ledger.ts), con diagnóstico seguro por llamada;
 *      4. producción con el MISMO pipeline de producto (directed-reel.ts):
 *         música compatible, imágenes con marcadores, voz con caché,
 *         cada operación pagada reservada antes de llamar;
 *      5. descarga el MP4 y extrae fotograma, hoja de contacto y loudness.
 *
 * Topes duros en código: US$1 total (monto autorizado) y US$0,75 por muestra (las entradas
 * solo pueden bajarlos). Operaciones inciertas: cuentan por su reserva y
 * bloquean su repetición; SAMPLE_ACKNOWLEDGE="<muestra>:<clave>|<nota>,…"
 * las recupera explícitamente (recovery.ts: comprueba presupuesto, libera el
 * marcador de imagen o el registro de voz y reconoce la entrada; el gasto
 * anterior sigue contando) para permitir reintentarlas.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const run = promisify(execFile);
const BUCKET = "videos";
const PREFIX = "samples/audiovisual";

async function main() {
  const { parseSampleManifest, resolveCaps, estimateSample, sampleBudgetDecision, SAMPLE_DURATION_SECONDS } = await import("../src/lib/video/audiovisual/sample-plan");
  const { voiceCostUsd, openStorageLedger } = await import("../src/lib/video/audiovisual/paid-costs");
  const { summarizeLedger } = await import("../src/lib/video/audiovisual/paid-ledger");
  const { readJsonState, writeJsonState } = await import("../src/lib/video/audiovisual/storage-state");

  const mode = (process.env.MODE ?? "plan").trim();
  const manifestPath = process.env.SAMPLE_MANIFEST ?? "docs/quality/audiovisual-samples/manifest.json";
  const manifest = parseSampleManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const selectedIds = (process.env.SAMPLES ?? "horror,comic-mystery").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = selectedIds.filter((id) => !manifest.samples.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Muestras desconocidas: ${unknown.join(", ")}`);
  const caps = resolveCaps({ totalUsd: process.env.SAMPLE_TOTAL_USD, perSampleUsd: process.env.SAMPLE_PER_SAMPLE_USD });
  const outDir = process.env.SAMPLE_OUT_DIR ?? path.join(process.cwd(), "audiovisual-samples-out");
  await fs.mkdir(outDir, { recursive: true });

  const rates = { imageTypicalUsd: 0.0558, voiceTypicalUsd: voiceCostUsd, scriptTypicalUsd: 0.03 };
  const estimates = Object.fromEntries(manifest.samples.map((s) => [s.id, estimateSample(s, rates)]));

  const hasSupabase = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const service = hasSupabase ? (await import("../src/lib/supabase/service")).createServiceClient() : null;

  // Comprometido por muestra desde los registros durables (incluye intentos fallidos e inciertos).
  // Se relee antes de cada muestra en modo run (sample-runner.ts).
  const loadCommitted = async () => {
    const committed: Record<string, number> = {};
    const uncertain: Record<string, string[]> = {};
    if (service) {
      for (const s of manifest.samples) {
        const state = await readJsonState<import("../src/lib/video/audiovisual/paid-ledger").PaidLedgerState>(service, BUCKET, `${PREFIX}/${s.id}/state/paid-ledger.json`, `el registro de ${s.id}`);
        if (state.kind === "found") {
          const sum = summarizeLedger(state.data);
          committed[s.id] = sum.committedUsd;
          uncertain[s.id] = sum.openUncertainKeys;
        }
      }
    }
    return { committed, uncertain };
  };
  const { committed: committedBySample, uncertain: uncertainBySample } = await loadCommitted();
  // Informativo: en modo run la decisión se recalcula antes de cada muestra con el acumulado actualizado.
  const plan = selectedIds.map((id) => ({ ...estimates[id], decision: sampleBudgetDecision({ caps, committedBySample, sampleId: id, estimate: estimates[id] }) }));
  console.log(
    `@@PLAN ${JSON.stringify({ mode, caps, selected: selectedIds, committedBySample, uncertainBySample, totalCommittedUsd: Object.values(committedBySample).reduce((a, b) => a + b, 0), plan, ledgerRead: hasSupabase })}`,
  );
  await fs.writeFile(path.join(outDir, "plan.json"), JSON.stringify({ caps, plan, committedBySample, uncertainBySample }, null, 2));
  if (mode !== "run") {
    console.log("Modo plan: no se llamó a ningún proveedor.");
    return;
  }

  // ---- Modo run (gasto real) ----
  if (process.env.SAMPLE_ALLOW_PAID !== "true") throw new Error("MODE=run exige SAMPLE_ALLOW_PAID=true (autorización explícita de gasto).");
  if (!service) throw new Error("Faltan credenciales de Supabase: sin registro durable no se gasta.");
  const needsImages = selectedIds.some((id) => estimates[id].images > 0);
  const missing = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "PEXELS_API_KEY", ...(needsImages ? ["OPENAI_API_KEY"] : [])].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new Error(`Faltan claves: ${missing.join(", ")}. No se llamó a ningún proveedor.`);
  Object.assign(process.env, {
    ATOMIVID_RUNTIME: "production", // nunca sustituir por contenido simulado
    SCRIPT_PROVIDER: "anthropic",
    VOICE_PROVIDER: "elevenlabs",
    FOOTAGE_PROVIDER: "pexels",
    MUSIC_PROVIDER: "curated-library",
    IMAGE_PROVIDER: "openai",
    OPENAI_IMAGE_GENERATION_ENABLED: "true",
  });

  const { resolveDirection } = await import("../src/lib/video/audiovisual/direction");
  const { anticipatedIntent, scriptGuidanceFor } = await import("../src/lib/video/audiovisual/catalog");
  const { generateScriptForRequest } = await import("../src/lib/video/generate-script");
  const { checkScriptQuality } = await import("../src/lib/video/script-quality");
  const { targetWordsFor } = await import("../src/lib/video/script-pacing");
  const { generateDirectedVideoFromScript } = await import("../src/lib/video/audiovisual/directed-reel");
  const { scriptScope, assertScriptGenerationClear, ledgeredScriptRunner } = await import("../src/lib/video/audiovisual/script-ledger");
  // Identificador del intento para trazar el registro (el run de GitHub Actions; local: marca de tiempo).
  const attempt = Number((process.env.GITHUB_RUN_ID ?? String(Date.now())).slice(-9));

  const { runSamplesSerially } = await import("../src/lib/video/audiovisual/sample-runner");
  const { recoverPaidOperation } = await import("../src/lib/video/audiovisual/recovery");
  const acknowledgements = (process.env.SAMPLE_ACKNOWLEDGE ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const final = await runSamplesSerially({
    sampleIds: selectedIds,
    caps,
    estimates,
    loadCommitted: async () => (await loadCommitted()).committed,
    openLedger: (id, capUsd) => openStorageLedger(service, BUCKET, `${PREFIX}/${id}`, { capUsd }),
    log: (event, data) => console.log(`@@${event} ${JSON.stringify(data)}`),
    produce: async (sampleId, ledger, decision) => {
      const sample = manifest.samples.find((s) => s.id === sampleId)!;
      const prefix = `${PREFIX}/${sample.id}`;
      // Tope efectivo recién recalculado: por muestra y global (restando lo comprometido por las demás).
      process.env.MAX_VISUAL_COST_USD = String(decision.effectiveCapUsd);
      for (const ack of acknowledgements.filter((a) => a.startsWith(`${sample.id}:`))) {
        const [key, note] = ack.slice(sample.id.length + 1).split("|");
        // Recuperación coherente: presupuesto primero; luego marcador/registro de voz y reconocimiento.
        const recovered = await recoverPaidOperation({ supabase: service, bucket: BUCKET, ledger, key, note: note ?? "", capUsd: decision.effectiveCapUsd });
        console.log(`@@RECOVERED ${JSON.stringify({ sample: sample.id, ...recovered })}`);
      }

      // Guion: una sola vez; se reutiliza en reintentos.
      const scriptPath = `${prefix}/script.json`;
      const stored = await readJsonState<import("../src/lib/providers/types").GeneratedScript>(service, BUCKET, scriptPath, `el guion de ${sample.id}`);
      let script = stored.kind === "found" ? stored.data : null;
      if (!script) {
        const guidance = scriptGuidanceFor(anticipatedIntent(sample.selection, sample.style));
        const key = createHash("sha256").update(JSON.stringify([sample.topic, sample.style, SAMPLE_DURATION_SECONDS, guidance ?? ""])).digest("hex").slice(0, 16);
        // Cada llamada real a Claude (borrador, correcciones de longitud,
        // reintentos permitidos) es su propia entrada del registro, liquidada
        // con los tokens medidos. Una generación anterior con llamadas
        // inciertas o pagadas sin guion guardado bloquea hasta recuperarla.
        const scope = scriptScope(prefix);
        assertScriptGenerationClear(ledger, scope);
        const generated = await generateScriptForRequest({
          topic: sample.topic,
          style: sample.style,
          durationSeconds: SAMPLE_DURATION_SECONDS,
          language: "es",
          ...(guidance ? { guidance } : {}),
          runCall: ledgeredScriptRunner(ledger, scope, key, attempt),
        });
        const quality = checkScriptQuality(generated.script, { topic: sample.topic, targetWords: targetWordsFor(SAMPLE_DURATION_SECONDS), providerName: generated.providerName });
        if (!quality.ok) throw new Error(`Guion de ${sample.id} no pasó el control de calidad (${quality.issue}). Detenido sin regenerar.`);
        script = generated.script;
        await writeJsonState(service, BUCKET, scriptPath, script);
      }

      const direction = resolveDirection({ selection: sample.selection, style: sample.style, topic: sample.topic, scenes: script.segments });
      console.log(`@@DIRECTION ${JSON.stringify({ sample: sample.id, summary: direction.summary, intent: direction.intent, music: direction.music, pace: direction.pace })}`);
      const started = Date.now();
      const { videoPath } = await generateDirectedVideoFromScript({
        supabase: service,
        requestId: prefix,
        artifactPrefix: `${prefix}/run-${attempt}`,
        script,
        style: sample.style,
        topic: sample.topic,
        language: "es",
        targetDurationSeconds: SAMPLE_DURATION_SECONDS,
        direction,
        attempt,
        paid: { ledger, recordCosts: false },
        onProgress: (stage) => console.log(`  [${sample.id}] etapa: ${stage}`),
      });

      const { data, error } = await service.storage.from(BUCKET).download(videoPath);
      if (error || !data) throw new Error(`No se pudo descargar el MP4 de ${sample.id}: ${error?.message}`);
      const mp4 = path.join(outDir, `${sample.id}.mp4`);
      await fs.writeFile(mp4, Buffer.from(await data.arrayBuffer()));
      await run("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-frames:v", "1", path.join(outDir, `${sample.id}-first-frame.png`)]);
      await run("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-vf", "fps=1/3,scale=216:384,tile=5x2", "-frames:v", "1", path.join(outDir, `${sample.id}-sheet.png`)]);
      const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", mp4, "-af", "ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 1 << 26 });
      const summary = stderr.slice(stderr.lastIndexOf("Summary"));
      const report = {
        sample: sample.id,
        purpose: sample.purpose,
        direction: direction.summary,
        seconds: (Date.now() - started) / 1000,
        loudness: { integratedLufs: /I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1], truePeakDbfs: /Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] },
        ledger: ledger.summary(),
      };
      await fs.writeFile(path.join(outDir, `${sample.id}-report.json`), JSON.stringify(report, null, 2));
      console.log(`@@SAMPLE ${JSON.stringify(report)}`);
    },
  });
  console.log(`@@SUMMARY ${JSON.stringify({ committedBySample: final.committedBySample, totalCommittedUsd: Object.values(final.committedBySample).reduce((a, b) => a + b, 0), caps })}`);
}

main().catch((err) => {
  console.error("Muestras audiovisuales detenidas:", err instanceof Error ? err.message : err);
  process.exit(1);
});
