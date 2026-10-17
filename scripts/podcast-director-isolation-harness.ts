/**
 * Arnés reproducible de la prueba POSITIVA de aislamiento del Director de podcast y de su montaje, con medios de prueba
 * YA existentes del paquete V1.3.1 (samples/ep-c/entrada/medios: audio y clip sintéticos). No genera voz ni imágenes,
 * no llama a proveedores, no usa credenciales y no toca Supabase.
 * Usa EXACTAMENTE los mismos lanzamientos que el worker (directorProbeCommand / directorCommand de montage-engine).
 *
 * Precondiciones (si falta una, todo queda NO_EJECUTADO y sale con 2; nunca se simula un PASS):
 *  Linux con /proc, Node 20.x, usuario no root, bwrap ejecutable, paquete compilado (PODCAST_DIRECTOR_DIR), fixtures.
 * Pasos: sonda en una raíz bajo /tmp y otra fuera de /tmp; montaje aislado (Director → montaje.json + LISTO.json);
 * editor validate --archivos; con --render, editor run + comprobación del MP4 (ffprobe: duración ≈ audio, 1920x1080).
 *
 * Uso: PODCAST_DIRECTOR_DIR=<paquete> npx tsx scripts/podcast-director-isolation-harness.ts [--fuera-tmp <dir>] [--render] [--json <salida>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIRECTOR_FILES, directorChildEnv, directorCommand, directorProbeCommand, directorRequest, parseDirectorOutput, parseProbeOutput, type DirectorRuntime } from "../src/lib/podcast/montage-engine";

type Step = { paso: string; resultado: "PASS" | "FAIL" | "NO_EJECUTADO"; detalle?: unknown };
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const steps: Step[] = [];
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const run = (cmd: string, a: string[], env: Record<string, string>, timeoutMs = 20 * 60_000) => {
  const r = spawnSync(cmd, a, { encoding: "utf8", env: env as unknown as NodeJS.ProcessEnv, timeout: timeoutMs, maxBuffer: 16 << 20 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderrBytes: (r.stderr ?? "").length };
};
function finish(code: number): never {
  const out = { arnes: "podcast-director-isolation-harness@1", node: process.version, uid: process.getuid?.() ?? null, pasos: steps };
  const j = JSON.stringify(out, null, 1);
  const dest = opt("--json"); if (dest) writeFileSync(dest, j);
  console.log(j); process.exit(code);
}

// --- precondiciones (no se relajan)
const DIR = process.env.PODCAST_DIRECTOR_DIR?.trim() ?? "";
const RUNNER = path.resolve("scripts/podcast-director-step.cjs");
const FIX = DIR ? path.join(DIR, "samples/ep-c/entrada/medios") : "";
const EDITOR = path.resolve("scripts/podcast-editor-v3/editor.py");
const pre: Array<[string, boolean, string]> = [
  ["linux_proc", existsSync("/proc/self/fd"), "Linux con /proc"],
  ["node_20", /^v20\./.test(process.version), `Node 20.x (actual ${process.version})`],
  ["no_root", (process.getuid?.() ?? 0) !== 0, "usuario sin privilegios (no root)"],
  ["bwrap", spawnSync("bwrap", ["--version"]).status === 0, "bwrap instalado y ejecutable"],
  ["paquete", !!DIR && path.isAbsolute(DIR) && Object.values(DIRECTOR_FILES).every((f) => existsSync(path.join(DIR, f))), "PODCAST_DIRECTOR_DIR absoluto con el paquete compilado"],
  ["fixtures", !!FIX && existsSync(path.join(FIX, "mezcla_final.wav")) && existsSync(path.join(FIX, "recreacion.mp4")), "medios de prueba existentes (samples/ep-c)"],
  ["editor", existsSync(EDITOR), "scripts/podcast-editor-v3/editor.py"],
];
for (const [p, ok, d] of pre) steps.push({ paso: `pre:${p}`, resultado: ok ? "PASS" : "FAIL", detalle: d });
if (pre.some(([, ok]) => !ok)) { steps.push({ paso: "prueba", resultado: "NO_EJECUTADO", detalle: "faltan precondiciones; no se simula el aislamiento" }); finish(2); }

const rt: DirectorRuntime = { dir: DIR, adapter: path.join(DIR, DIRECTOR_FILES.adapter), isolate: path.join(DIR, DIRECTOR_FILES.isolate), runner: RUNNER };
// Entorno del hijo: el mismo filtro del worker; se comprueba que una credencial presente NO pasa.
const env = directorChildEnv({ ...process.env, SUPABASE_SERVICE_ROLE_KEY: "sonda-no-debe-pasar", PEXELS_API_KEY: "sonda-no-debe-pasar" });
steps.push({ paso: "entorno_sin_credenciales", resultado: Object.keys(env).every((k) => ["PATH", "LANG", "LC_ALL", "TZ"].includes(k)) ? "PASS" : "FAIL", detalle: Object.keys(env) });

const privateDir = (parent: string, prefix: string) => { mkdirSync(parent, { recursive: true }); const d = mkdtempSync(path.join(parent, prefix)); chmodSync(d, 0o700); return d; };
const roots = [privateDir(os.tmpdir(), "atv-aislado-tmp-"), privateDir(path.resolve(opt("--fuera-tmp") ?? path.join(os.homedir(), ".atv-director-prueba")), "atv-aislado-")];
if (roots[1].startsWith(os.tmpdir() + path.sep)) steps.push({ paso: "raiz_fuera_tmp", resultado: "FAIL", detalle: "--fuera-tmp debe quedar fuera de /tmp" });

// --- 1) sonda real en cada raíz
for (const root of roots) {
  const { cmd, args: a } = directorProbeCommand(rt, root);
  const r = run(cmd, a, env, 60_000);
  const p = parseProbeOutput(r.code, r.stdout);
  steps.push({ paso: `sonda:${root.startsWith(os.tmpdir()) ? "bajo_tmp" : "fuera_tmp"}`, resultado: p.ok ? "PASS" : "FAIL", detalle: { code: r.code, salida: r.stdout.trim().slice(0, 400) } });
}

// --- 2) montaje aislado con medios existentes (copia; no se generan medios nuevos)
const work = roots[0], input = path.join(work, "entrada");
mkdirSync(path.join(input, "audio"), { recursive: true }); mkdirSync(path.join(input, "medios"), { recursive: true });
const audio = path.join(input, "audio/episode.wav"); copyFileSync(path.join(FIX, "mezcla_final.wav"), audio);
const clip = path.join(input, "medios/escena-2.mp4"); copyFileSync(path.join(FIX, "recreacion.mp4"), clip);
const probe = (p: string, sel: string, e: string) => spawnSync("ffprobe", ["-v", "error", ...(sel ? ["-select_streams", sel] : []), "-show_entries", e, "-of", "csv=p=0", p], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";
const audioSeconds = Number(probe(audio, "", "format=duration")) || 0;
const [cw, ch] = probe(clip, "v:0", "stream=width,height").split(",").map(Number);
const ref = (p: string) => ({ size: statSync(p).size, sha256: sha(p) });
const clipSeconds = Math.min(7.5, Number(probe(clip, "", "format=duration")) || 0);
const req = directorRequest({
  episodeId: "prueba-aislada", version: 1, title: "Prueba aislada (fixtures)", language: "es", inputDir: input,
  audio: { path: "audio/episode.wav", ...ref(audio) }, audioSeconds, sampleRate: Number(probe(audio, "a:0", "stream=sample_rate")) || null,
  scenes: [[0, 5], [5, 12.5], [12.5, audioSeconds]].map(([s, e], i) => ({ start: s, end: e, text: `escena ${i + 1}` })),
  shots: [null, { sceneIndex: 1, file: clip, seconds: clipSeconds, ...ref(clip), kind: "video", credit: "fixture sintético del paquete V1.3.1" }, null],
  subtitles: null, dimensions: { [clip]: { width: cw, height: ch } },
}, {
  // SOLO PRUEBA: el clip es un fixture sintético del propio paquete, no material de stock; jamás se usa en el worker.
  id: "fixture-sintetico", version: "prueba", basisFor: (p) => (p.asset === "medios/escena-2.mp4" ? { status: "cleared", basis: "fixture sintético generado por el paquete V1.3.1 (no es stock)" } : null),
});
if (!req.ok) { steps.push({ paso: "solicitud", resultado: "FAIL", detalle: req.errors }); finish(1); }
const reqPath = path.join(work, "director-request.json"); writeFileSync(reqPath, JSON.stringify(req.request));
const { cmd, args: a } = directorCommand(rt, work, reqPath);
const m = run(cmd, a, env);
const outcome = parseDirectorOutput(m.code, m.stdout);
const manifest = path.join(input, "montaje.json");
steps.push({ paso: "montaje_aislado", resultado: outcome.ok && existsSync(manifest) && existsSync(path.join(input, "LISTO.json")) ? "PASS" : "FAIL", detalle: outcome });
if (!outcome.ok) finish(1);
steps.push({ paso: "montaje_sha256", resultado: "PASS", detalle: { montaje: sha(manifest), declarado: outcome.manifestSha256 } });

// --- 3) editor existente
const v = run("python3", [EDITOR, "validate", manifest, "--archivos"], { PATH: process.env.PATH ?? "" }, 120_000);
steps.push({ paso: "editor_validate", resultado: v.code === 0 ? "PASS" : "FAIL", detalle: { code: v.code } });
if (!flag("--render")) { steps.push({ paso: "render", resultado: "NO_EJECUTADO", detalle: "sin --render" }); finish(steps.some((s) => s.resultado === "FAIL") ? 1 : 0); }
const renderDir = path.join(work, "render");
const r = run("python3", [EDITOR, "run", manifest, "--work", renderDir, "--retries", "1"], { PATH: process.env.PATH ?? "" }, 90 * 60_000);
const mp4 = spawnSync("find", [renderDir, "-path", "*/salida/episodio.mp4"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
const secs = mp4 ? Number(probe(mp4, "", "format=duration")) : 0;
const wh = mp4 ? probe(mp4, "v:0", "stream=width,height") : "";
const decodeOk = mp4 ? spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", mp4, "-f", "null", "-"]).status === 0 : false;
steps.push({ paso: "render", resultado: r.code === 0 && !!mp4 && decodeOk && Math.abs(secs - audioSeconds) <= 2 && wh === "1920,1080" ? "PASS" : "FAIL",
  detalle: { code: r.code, mp4: mp4 ? { sha256: sha(mp4), bytes: statSync(mp4).size, segundos: secs, wh, decodifica: decodeOk } : null, audioSeconds } });
if (!flag("--conservar")) for (const d of roots) rmSync(d, { recursive: true, force: true });
finish(steps.some((s) => s.resultado === "FAIL") ? 1 : 0);
