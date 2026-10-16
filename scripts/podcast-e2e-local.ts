/**
 * Prueba integrada LOCAL del podcast (USD 0): solicitud → revisión → confirmación → worker produce() REAL → montaje →
 * editor existente (scripts/podcast-editor-v3) → MP4 local descargable, más fallos sin pagos.
 * Servicios FALSOS: Supabase (tabla del episodio y Storage en una carpeta local), avisos y registro de gastos.
 * Medios: SOLO existentes (audio de prueba del paquete V1.3.1, samples/ep-c/entrada/medios/mezcla_final.wav, pasado a
 * M4A como el audio que guarda la plataforma). Sin proveedores: el episodio ya tiene audio (no se narra) y no hay clave
 * de Pexels (no se busca stock); cualquier llamada al narrador o al stock cuenta como fallo de la prueba.
 * El motor Director exige aislamiento real (bwrap + UID dedicado): aquí se comprueba que BLOQUEA antes de gastar; su
 * prueba positiva es scripts/podcast-director-isolation-harness.ts (no se salta el aislamiento).
 *
 * Uso: PODCAST_E2E_AUDIO=<wav existente> npx tsx scripts/podcast-e2e-local.ts --out <dir> [--solo <escenario>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { produce, type ProduceInject } from "./podcast-video-worker";
import { unsupportedOption } from "../src/lib/podcast/production-contract";
import { checkConfirmation, productionFingerprint } from "../src/lib/podcast/production-confirm";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const OUT = path.resolve(opt("--out") ?? "podcast-e2e-salida");
const ONLY = opt("--solo");
const SRC = process.env.PODCAST_E2E_AUDIO ?? "";
if (!SRC || !existsSync(SRC)) { console.error("falta PODCAST_E2E_AUDIO (audio de prueba existente)"); process.exit(2); }
const EDITOR = path.resolve("scripts/podcast-editor-v3/editor.py");
const FAULT = path.resolve("scripts/podcast-e2e/editor-fault.py");
const sha = (b: Buffer | string) => createHash("sha256").update(typeof b === "string" ? readFileSync(b) : b).digest("hex");
const probe = (p: string, sel: string, e: string) => spawnSync("ffprobe", ["-v", "error", ...(sel ? ["-select_streams", sel] : []), "-show_entries", e, "-of", "csv=p=0", p], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";

rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
// Audio "guardado" de la plataforma: derivado local (AAC) del audio de prueba existente; no es voz nueva.
const audioM4a = path.join(OUT, "audio-guardado.m4a");
const ff = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", SRC, "-c:a", "aac", "-b:a", "128k", audioM4a]);
if (ff.status !== 0) { console.error("no se pudo preparar el audio"); process.exit(2); }
const audioBytes = readFileSync(audioM4a);
const audioSeconds = Number(probe(audioM4a, "", "format=duration"));

type Row = Record<string, unknown> & { id: string; video_run_token: string | null };
function world(name: string) {
  const id = "00000000-0000-4000-8000-0000000000e2";
  const row: Row = {
    id, user_id: "hans-prueba", title: "Episodio de prueba integrada", language: "es", source: "tts", script: "Guion ya narrado (fixture).", voice_id: "voz-guardada", voice_name: "Voz guardada",
    characters: 27, estimated_usd: 0, status: "ready", audio_path: `hans-prueba/podcasts/${id}/audio/episodio.m4a`, audio_sha256: sha(audioBytes), duration_seconds: audioSeconds,
    video_status: "queued", video_run_token: "token-1", video_attempts: 1, budget_usd: 1, cost_usd: 0, video_stage: null, review_status: "pending", publish_status: "held",
  };
  const storageDir = path.join(OUT, name, "storage");
  const calls = { narration: 0, stock: 0, uploads: [] as string[], audioDownloads: 0, audioWrites: 0 };
  const query = { eq: () => query, single: async () => ({ data: { ...row } }), maybeSingle: async () => ({ data: null, error: null }) };
  const service = {
    from: (table: string) => ({
      select: () => query,
      update: (patch: Record<string, unknown>) => {
        const conds: Record<string, unknown> = {};
        const q = { eq: (k: string, v: unknown) => { conds[k] = v; return q; }, select: async () => {
          if (table !== "podcast_episodes" || conds.id !== row.id || (conds.video_run_token !== undefined && conds.video_run_token !== row.video_run_token)) return { data: [] };
          Object.assign(row, patch); return { data: [{ id: row.id }] };
        } };
        return q;
      },
    }),
    storage: { from: () => ({
      download: async (p: string) => { if (p === row.audio_path) { calls.audioDownloads++; return { data: new Blob([audioBytes]), error: null }; } return { data: null, error: { message: "no existe" } }; },
      upload: async (p: string, body: Buffer) => {
        if (p === row.audio_path) calls.audioWrites++;
        const dest = path.join(storageDir, p); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, body); calls.uploads.push(p); return { error: null };
      },
    }) },
  };
  const inject: ProduceInject = {
    service: service as never,
    runGeneration: (async () => { calls.narration++; return { error: "la prueba no narra", status: 500 }; }) as never,
    buildSceneShots: (async () => { calls.stock++; return []; }) as never,
    pilot: {
      productionSpend: (async () => ({ spentUsd: 0, uncertainUsd: 0, uncertain: 0 })) as never,
      pendingNarration: (async () => ({ usd: 0, chunks: 1 })) as never,
      readRunBudget: (async () => ({ available: true, value: null })) as never,
      recordNotice: (async () => null) as never,
    },
  };
  return { row, calls, inject, storageDir };
}

function verifyMp4(file: string) {
  const secs = Number(probe(file, "", "format=duration"));
  const wh = probe(file, "v:0", "stream=width,height");
  const codecs = [probe(file, "v:0", "stream=codec_name"), probe(file, "a:0", "stream=codec_name")];
  const decode = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  // Luminancia media de un fotograma a 1 s (tarjeta de título): no prueba legibilidad (no hay OCR), solo que hay imagen.
  const frame = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"]);
  const lum = frame.stdout?.length ? [...frame.stdout].reduce((a, b) => a + b, 0) / frame.stdout.length : 0;
  return { bytes: statSync(file).size, sha256: sha(file), segundos: secs, wh, codecs, decodifica_entero: decode.status === 0 && !decode.stderr.trim(), luminancia_1s: Math.round(lum),
    duracion_ok: Math.abs(secs - audioSeconds) <= 2, resolucion_ok: wh === "1920,1080" };
}

type Res = { escenario: string; resultado: "PASS" | "FAIL"; esperado: string; obtenido: Record<string, unknown> };
const results: Res[] = [];
async function scenario(name: string, esperado: string, env: Record<string, string | undefined>, inj: Partial<ProduceInject>, check: (w: ReturnType<typeof world>) => [boolean, Record<string, unknown>], prepare?: (w: ReturnType<typeof world>) => void) {
  if (ONLY && ONLY !== name) return;
  const saved = { ...process.env };
  for (const k of ["PODCAST_MONTAGE_ENGINE", "PODCAST_DIRECTOR_DIR", "PODCAST_DIRECTOR_UID", "PEXELS_API_KEY", "PODCAST_TOKEN_FILE", "PODCAST_E2E_FAULT"]) delete process.env[k];
  Object.assign(process.env, env, { PODCAST_E2E_EDITOR: EDITOR });
  const w = world(name);
  prepare?.(w);
  const t0 = Date.now();
  await produce(w.row.id, { ...w.inject, ...inj });
  process.exitCode = 0;
  const [ok, info] = check(w);
  results.push({ escenario: name, resultado: ok ? "PASS" : "FAIL", esperado, obtenido: { ...info, segundos_reloj: Math.round((Date.now() - t0) / 1000), narracion: w.calls.narration, stock: w.calls.stock, audio_reescrito: w.calls.audioWrites } });
  process.env = saved;
}
const mp4Of = (w: ReturnType<typeof world>) => { const p = w.row.video_path as string | undefined; return p ? path.join(w.storageDir, p) : null; };
const noSpend = (w: ReturnType<typeof world>) => w.calls.narration === 0 && w.calls.stock === 0 && w.calls.audioWrites === 0;

(async () => {
  // 1) solicitud → revisión → confirmación (contrato real de T25; las rutas HTTP con sesión quedan fuera)
  {
    const w = world("contrato");
    const ep = w.row as never as Parameters<typeof productionFingerprint>[0];
    const fp = productionFingerprint(ep);
    const ok = unsupportedOption({ title: "x", narrationMode: "un_narrador" }) === null && !!unsupportedOption({ narrationMode: "dos_narradores" })
      && "ok" in checkConfirmation(ep, fp) && (checkConfirmation({ ...ep, title: "cambiado" }, fp) as { status?: number }).status === 409;
    if (!ONLY || ONLY === "contrato") results.push({ escenario: "contrato", resultado: ok ? "PASS" : "FAIL", esperado: "un narrador aceptado, dos rechazado; confirmación válida; cambiada → 409", obtenido: { huella: fp } });
  }
  // 2) recorrido completo legacy → MP4 descargable
  await scenario("legacy-mp4", "ready con MP4 1080p que se decodifica entero y dura lo que el audio; sin narración ni stock", {}, {}, (w) => {
    const f = mp4Of(w); const v = f && existsSync(f) ? verifyMp4(f) : null;
    const checks = w.row.video_checks as { checks?: { id: string; ok: boolean }[]; defects?: unknown[] } | undefined;
    return [w.row.video_status === "ready" && !!v && v.decodifica_entero && v.duracion_ok && v.resolucion_ok && noSpend(w) && w.row.publish_status === "held",
      { video_status: w.row.video_status, video_path: w.row.video_path, mp4: v, checks: checks?.checks, defectos: checks?.defects, review: w.row.review_status, publicacion: w.row.publish_status }];
  });
  // 3) configuración incompleta del Director → bloqueo antes de gastar
  await scenario("director-config-incompleta", "blocked DIRECTOR_ENV_MISSING antes de narrar", { PODCAST_MONTAGE_ENGINE: "director" }, {}, (w) =>
    [w.row.video_status === "blocked" && /DIRECTOR_ENV_MISSING/.test(String(w.row.video_error)) && noSpend(w) && !w.row.video_path, { video_status: w.row.video_status, video_error: w.row.video_error }]);
  // 4) Director con paquete real pero SIN aislamiento disponible aquí → bloqueo (no se salta)
  await scenario("director-sin-aislamiento", "blocked por aislamiento ausente (bwrap/UID), sin montaje ni gasto",
    { PODCAST_MONTAGE_ENGINE: "director", PODCAST_DIRECTOR_DIR: process.env.PODCAST_E2E_DIRECTOR_DIR ?? "", PODCAST_DIRECTOR_UID: String(process.getuid?.() ?? "") }, {}, (w) =>
      [w.row.video_status === "blocked" && /DIRECTOR_(ISOLATION_MISSING|UID_NOT_DEDICATED|ISOLATION_PROBE_FAILED|MODULE_MISSING|ENV_MISSING)/.test(String(w.row.video_error)) && noSpend(w) && !w.row.video_path,
        { video_status: w.row.video_status, video_error: w.row.video_error }]);
  // 5) medio alterado entre el montaje y el editor → falla la validación; audio guardado intacto
  await scenario("medio-alterado", "failed en la validación del editor; nada entregado; audio guardado sin tocar", { PODCAST_E2E_FAULT: "tamper" }, { editor: FAULT }, (w) =>
    [w.row.video_status === "failed" && /validación del editor/.test(String(w.row.video_error)) && !w.row.video_path && noSpend(w), { video_status: w.row.video_status, video_error: w.row.video_error }]);
  // 6) interrupción del render y reintento (intento 2) → ready; el audio no se vuelve a generar
  if (!ONLY || ONLY === "interrupcion-reintento") {
    const saved = { ...process.env };
    process.env.PODCAST_E2E_EDITOR = EDITOR; process.env.PODCAST_E2E_FAULT = "kill"; delete process.env.PODCAST_MONTAGE_ENGINE; delete process.env.PEXELS_API_KEY;
    const w = world("interrupcion-reintento");
    await produce(w.row.id, { ...w.inject, editor: FAULT }); process.exitCode = 0;
    const first = { video_status: w.row.video_status, video_error: w.row.video_error };
    // La app re-encola: nuevo token e intento 2 (lo que hace requestPodcastVideo al pulsar «Reintentar»).
    Object.assign(w.row, { video_status: "queued", video_run_token: "token-2", video_attempts: 2 });
    delete process.env.PODCAST_E2E_FAULT;
    await produce(w.row.id, w.inject); process.exitCode = 0;
    const f = mp4Of(w); const v = f && existsSync(f) ? verifyMp4(f) : null;
    const ok = first.video_status === "failed" && w.row.video_status === "ready" && !!v?.decodifica_entero && !!v?.duracion_ok && noSpend(w) && String(w.row.video_path).includes("/video/v2/");
    results.push({ escenario: "interrupcion-reintento", resultado: ok ? "PASS" : "FAIL", esperado: "1.º failed (render interrumpido); 2.º ready en v2 con el mismo audio, sin narrar",
      obtenido: { primero: first, segundo: { video_status: w.row.video_status, video_path: w.row.video_path, mp4: v }, descargas_audio: w.calls.audioDownloads, narracion: w.calls.narration, audio_reescrito: w.calls.audioWrites,
        nota: "cada intento usa su carpeta de trabajo (podcast-<id>-<intento>): no hay reuso de bloques de render entre intentos; no se afirma" } });
    process.env = saved;
  }
  const summary = { prueba: "podcast-e2e-local@1", audio_prueba: { origen_sha256: sha(SRC), m4a_sha256: sha(audioBytes), segundos: audioSeconds }, resultados: results };
  writeFileSync(path.join(OUT, "resultado.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  process.exit(results.every((r) => r.resultado === "PASS") ? 0 : 1);
})();
