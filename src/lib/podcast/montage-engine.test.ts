import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DIRECTOR_FILES, directorChildEnv, directorCommand, directorProbeCommand, directorRequest, engineBlockMessage, montageGate, parseDirectorOutput,
  parseProbeOutput, resolveMontageEngine, type DirectorRequestInput, type EngineDeps, type GateDeps, type RightsPolicy,
} from "./montage-engine";

const RUNNER = path.resolve("scripts/podcast-director-step.cjs");
const DIR = "/opt/director";
const ALL = new Set([...Object.values(DIRECTOR_FILES).map((f) => path.join(DIR, f)), RUNNER, "/proc/self/fd"]);
const deps = (env: Record<string, string | undefined>, over: Partial<EngineDeps> = {}): EngineDeps =>
  ({ env, uid: 1500, exists: (p) => ALL.has(p), onPath: (c) => c === "bwrap", runner: RUNNER, ...over });
const DIRECTOR_ENV = { PODCAST_MONTAGE_ENGINE: "director", PODCAST_DIRECTOR_DIR: DIR, PODCAST_DIRECTOR_UID: "1500" };
const codes = (c: ReturnType<typeof resolveMontageEngine>) => (c.ok ? [] : c.errors.map((e) => e.code));

test("motor: legacy por defecto (sin variable, vacía o «legacy»), aunque falte todo lo del Director", () => {
  for (const v of [undefined, "", "  ", "legacy"]) {
    const c = resolveMontageEngine(deps({ PODCAST_MONTAGE_ENGINE: v }, { exists: () => false, onPath: () => false, uid: 0 }));
    assert.deepEqual(c, { ok: true, engine: "legacy" });
  }
});

test("motor: un valor desconocido es un error estructurado, nunca otro motor en silencio", () => {
  for (const v of ["Director", "LEGACY", "grok", "director;rm"]) {
    const c = resolveMontageEngine(deps({ PODCAST_MONTAGE_ENGINE: v }));
    assert.equal(c.ok, false); assert.deepEqual(codes(c), ["MONTAGE_ENGINE_UNKNOWN"]);
  }
});

test("motor director: con todas las barreras devuelve las rutas del adaptador existente y del aislamiento", () => {
  const c = resolveMontageEngine(deps(DIRECTOR_ENV));
  assert.ok(c.ok && c.engine === "director");
  assert.equal(c.runtime.adapter, path.join(DIR, "dist/adaptador/worker-adapter.js"));
  assert.equal(c.runtime.isolate, path.join(DIR, "scripts/ejecutar_aislado.sh"));
});

test("motor director: falta de módulo o de entorno → error estructurado con su código", () => {
  assert.deepEqual(codes(resolveMontageEngine(deps({ ...DIRECTOR_ENV, PODCAST_DIRECTOR_DIR: undefined }))), ["DIRECTOR_ENV_MISSING"]);
  assert.deepEqual(codes(resolveMontageEngine(deps({ ...DIRECTOR_ENV, PODCAST_DIRECTOR_DIR: "relativa/dir" }))), ["DIRECTOR_ENV_MISSING"]);
  const sin = resolveMontageEngine(deps(DIRECTOR_ENV, { exists: (p) => ALL.has(p) && !p.endsWith("worker-adapter.js") }));
  assert.deepEqual(codes(sin), ["DIRECTOR_MODULE_MISSING"]);
  assert.match(sin.ok ? "" : sin.errors[0].message, /dist\/adaptador\/worker-adapter\.js/);
});

test("motor director: sin bwrap, como root, sin UID dedicado, con ganchos de prueba o sin /proc → bloqueado", () => {
  assert.deepEqual(codes(resolveMontageEngine(deps(DIRECTOR_ENV, { onPath: () => false }))), ["DIRECTOR_ISOLATION_MISSING"]);
  assert.deepEqual(codes(resolveMontageEngine(deps({ ...DIRECTOR_ENV, PODCAST_DIRECTOR_UID: "0" }, { uid: 0 }))), ["DIRECTOR_UID_NOT_DEDICATED"]);
  assert.deepEqual(codes(resolveMontageEngine(deps({ ...DIRECTOR_ENV, PODCAST_DIRECTOR_UID: undefined }))), ["DIRECTOR_UID_NOT_DEDICATED"]);
  assert.deepEqual(codes(resolveMontageEngine(deps({ ...DIRECTOR_ENV, PODCAST_DIRECTOR_UID: "1501" }))), ["DIRECTOR_UID_NOT_DEDICATED"]);
  assert.deepEqual(codes(resolveMontageEngine(deps({ ...DIRECTOR_ENV, DIRECTOR_PAUSA_EN: "x" }))), ["DIRECTOR_TEST_HOOKS_SET"]);
  assert.deepEqual(codes(resolveMontageEngine(deps(DIRECTOR_ENV, { exists: (p) => ALL.has(p) && p !== "/proc/self/fd" }))), ["DIRECTOR_PROC_MISSING"]);
  const todo = resolveMontageEngine(deps({ PODCAST_MONTAGE_ENGINE: "director" }, { exists: () => false, onPath: () => false, uid: 0 }));
  assert.deepEqual(codes(todo), ["DIRECTOR_ENV_MISSING", "DIRECTOR_MODULE_MISSING", "DIRECTOR_ISOLATION_MISSING", "DIRECTOR_UID_NOT_DEDICATED", "DIRECTOR_PROC_MISSING"]);
  const msg = engineBlockMessage(todo.ok ? [] : todo.errors);
  assert.match(msg, /DIRECTOR_ISOLATION_MISSING/); assert.doesNotMatch(msg, /\/opt|\/tmp/); assert.ok(msg.length <= 500);
});

const INPUT = "/w/entrada";
const base = (over: Partial<DirectorRequestInput> = {}): DirectorRequestInput => ({
  episodeId: "ep-1", version: 0, title: "T", language: "es", inputDir: INPUT,
  audio: { path: "audio/episode.m4a", size: 10, sha256: "a".repeat(64) }, audioSeconds: 20, sampleRate: 44100,
  scenes: [{ start: 0, end: 10, text: "uno" }, { start: 10, end: 20, text: "dos" }],
  shots: [null, { sceneIndex: 1, file: `${INPUT}/medios/escena-2.mp4`, seconds: 10, size: 5, sha256: "b".repeat(64), kind: "photo", credit: "Pexels" }],
  subtitles: null, dimensions: { [`${INPUT}/medios/escena-2.mp4`]: { width: 1920, height: 1080 } }, ...over,
});

test("solicitud: dimensiones medidas por ruta relativa; sin derechos ni avatar inventados; versión ≥ 1", () => {
  const r = directorRequest(base());
  assert.ok(r.ok);
  assert.deepEqual(r.request.dimensions, { "medios/escena-2.mp4": { width: 1920, height: 1080 } });
  assert.deepEqual(r.request.rights, {}); assert.deepEqual(r.request.requireAvatarSegments, []);
  assert.equal(r.request.worker.version, 1); assert.equal(r.request.worker.sampleRate, 44100);
  const sinMedir = directorRequest(base({ dimensions: { [`${INPUT}/medios/escena-2.mp4`]: { width: 0, height: 1080 } } }));
  assert.ok(sinMedir.ok); assert.deepEqual(sinMedir.request.dimensions, {});
});

test("solicitud: audio sin frecuencia medida o no admitida → DIRECTOR_AUDIO_SAMPLE_RATE", () => {
  for (const sr of [null, 22050, 96000]) {
    const r = directorRequest(base({ sampleRate: sr }));
    assert.equal(r.ok, false); assert.equal(r.ok ? "" : r.errors[0].code, "DIRECTOR_AUDIO_SAMPLE_RATE");
  }
});

test("orden aislada y entorno del hijo: solo la raíz de trabajo escribible; sin credenciales ni ganchos", () => {
  const rt = { dir: DIR, adapter: "", isolate: `${DIR}/scripts/ejecutar_aislado.sh`, runner: RUNNER };
  const { cmd, args } = directorCommand(rt, "/w", "/w/director-request.json");
  assert.equal(cmd, "bash");
  assert.deepEqual(args.slice(0, 3), [rt.isolate, "--rw", "/w"]);
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(3, sep), ["--ro", DIR, "--ro", path.dirname(RUNNER), "--ro", path.dirname(process.execPath)], "paquete, runner y node en solo lectura explícito (el tmpfs de /tmp no los oculta)");
  assert.deepEqual(args.slice(sep + 1), [process.execPath, RUNNER, DIR, "/w/director-request.json"]);
  const probe = directorProbeCommand(rt, "/p");
  assert.deepEqual(probe.args.slice(0, sep), [rt.isolate, "--rw", "/p", ...args.slice(3, sep)], "la sonda usa el mismo lanzamiento");
  assert.deepEqual(probe.args.slice(sep + 1), [process.execPath, RUNNER, "--probe", DIR, "/p"]);
  const env = directorChildEnv({ PATH: "/usr/bin", LANG: "C.UTF-8", SUPABASE_SERVICE_ROLE_KEY: "x", PEXELS_API_KEY: "y", DIRECTOR_PAUSA_EN: "z", GITHUB_TOKEN: "t" });
  assert.deepEqual(env, { PATH: "/usr/bin", LANG: "C.UTF-8" });
});

test("salida del Director: ready, bloqueos con códigos, ilegible o código de salida → estructurado", () => {
  assert.deepEqual(parseDirectorOutput(0, `{"status":"ready","manifestSha256":"${"c".repeat(64)}"}\n`), { ok: true, manifestSha256: "c".repeat(64) });
  const b = parseDirectorOutput(2, '{"status":"blocked","blockers":[{"code":"WORKER_MISSING_RIGHTS","message":"m"}]}');
  assert.deepEqual(b, { ok: false, errors: [{ code: "WORKER_MISSING_RIGHTS", message: "m" }] });
  assert.deepEqual(parseDirectorOutput(0, "no json"), { ok: false, errors: [{ code: "DIRECTOR_OUTPUT_INVALID", message: "salida del Director ilegible" }] });
  assert.equal(parseDirectorOutput(70, "").ok, false);
  assert.equal((parseDirectorOutput(70, "") as { errors: { code: string }[] }).errors[0].code, "DIRECTOR_EXIT");
  assert.equal(parseDirectorOutput(1, `{"status":"ready","manifestSha256":"${"c".repeat(64)}"}`).ok, false, "ready con código ≠ 0 no cuenta");
  assert.equal(parseDirectorOutput(0, '{"status":"ready","manifestSha256":"corto"}').ok, false);
});

test("runner: módulo ausente o solicitud inválida → JSON estructurado y código 1", () => {
  const t = mkdtempSync(path.join(tmpdir(), "dstep-"));
  const req = path.join(t, "r.json");
  writeFileSync(req, JSON.stringify({ schema: "atomivid/podcast-director-step@1", worker: { inputDir: t } }));
  const r1 = spawnSync(process.execPath, [RUNNER, path.join(t, "no-existe"), req], { encoding: "utf8", env: directorChildEnv(process.env) as NodeJS.ProcessEnv });
  assert.equal(r1.status, 1); assert.equal(JSON.parse(r1.stdout).blockers[0].code, "DIRECTOR_MODULE_MISSING");
  writeFileSync(req, "{");
  const r2 = spawnSync(process.execPath, [RUNNER, t, req], { encoding: "utf8" });
  assert.equal(r2.status, 1); assert.equal(JSON.parse(r2.stdout).blockers[0].code, "DIRECTOR_REQUEST_INVALID");
});

// Con el paquete real del Director compilado (opcional): PODCAST_DIRECTOR_TEST_DIR=<codigo V1.3.1>.
const REAL = process.env.PODCAST_DIRECTOR_TEST_DIR?.trim();
const real = !!REAL && existsSync(path.join(REAL, DIRECTOR_FILES.adapter));

test("adaptador real: entradas incompletas (sin derechos) → WORKER_MISSING_RIGHTS sin escribir nada", { skip: !real && "sin PODCAST_DIRECTOR_TEST_DIR" }, () => {
  const t = mkdtempSync(path.join(tmpdir(), "dreal-")); const input = path.join(t, "entrada"); mkdirSync(path.join(input, "medios"), { recursive: true });
  const r = directorRequest({ ...base(), inputDir: input, shots: [null, { ...base().shots[1]!, file: path.join(input, "medios/escena-2.mp4") }], dimensions: { [path.join(input, "medios/escena-2.mp4")]: { width: 1920, height: 1080 } } });
  assert.ok(r.ok);
  const reqPath = path.join(t, "director-request.json"); writeFileSync(reqPath, JSON.stringify(r.request));
  const p = spawnSync(process.execPath, [RUNNER, REAL!, reqPath], { encoding: "utf8", env: directorChildEnv(process.env) as NodeJS.ProcessEnv });
  const outcome = parseDirectorOutput(p.status ?? -1, p.stdout);
  assert.equal(p.status, 2);
  assert.deepEqual(outcome.ok ? [] : outcome.errors.map((e) => e.code), ["WORKER_MISSING_RIGHTS"]);
  assert.deepEqual(readdirSync(input).sort(), ["medios"], "bloqueado antes de materializar: ni montaje.json ni LISTO.json");
});

test("adaptador real: contrato input@1 desde los datos del worker (dimensiones medidas y derechos registrados)", { skip: !real && "sin PODCAST_DIRECTOR_TEST_DIR" }, () => {
  const { toDirectorInput } = createRequire(__filename)(path.join(REAL!, DIRECTOR_FILES.adapter)) as { toDirectorInput: (w: unknown, x: unknown) => Record<string, unknown> };
  const r = directorRequest(base()); assert.ok(r.ok);
  const blocked = toDirectorInput(r.request.worker, { dimensions: () => ({ width: 1920, height: 1080 }), rightsBasis: () => null, requireAvatarSegments: [] });
  assert.ok("blocked" in blocked);
  const inp = toDirectorInput(r.request.worker, { dimensions: () => ({ width: 1920, height: 1080 }), rightsBasis: () => ({ status: "cleared", basis: "fixture sintético de la prueba" }), requireAvatarSegments: [] }) as {
    schema: string; assemblyVersion: number; audio: { sampleRate: number; durationMs: number }; segments: { id: string }[]; assets: { path: string; description: string }[];
  };
  assert.equal(inp.schema, "atomicvid/podcast-director-input@1");
  assert.equal(inp.assemblyVersion, 1); assert.equal(inp.audio.sampleRate, 44100); assert.equal(inp.audio.durationMs, 20000);
  assert.deepEqual(inp.segments.map((s) => s.id), ["s001", "s002"]);
  assert.equal(inp.assets[0].path, "medios/escena-2.mp4"); assert.match(inp.assets[0].description, /fotografía animada/);
});

test("aislamiento real: sin bwrap el envoltorio del Director se niega (código 70) y el worker lo trata como error", { skip: (!real && "sin PODCAST_DIRECTOR_TEST_DIR") || (spawnSync("bash", ["-c", "command -v bwrap"]).status === 0 && "bwrap presente") }, () => {
  const t = mkdtempSync(path.join(tmpdir(), "diso-"));
  const { cmd, args } = directorCommand({ dir: REAL!, adapter: "", isolate: path.join(REAL!, DIRECTOR_FILES.isolate), runner: RUNNER }, t, path.join(t, "r.json"));
  const p = spawnSync(cmd, args, { encoding: "utf8", env: directorChildEnv(process.env) as NodeJS.ProcessEnv });
  assert.equal(p.status, 70);
  assert.equal((parseDirectorOutput(p.status ?? -1, p.stdout) as { errors: { code: string }[] }).errors[0].code, "DIRECTOR_EXIT");
  assert.equal(readFileSync(path.join(REAL!, DIRECTOR_FILES.isolate), "utf8").includes("no se ejecuta sin aislamiento"), true);
});

const gateDeps = (env: Record<string, string | undefined>, over: Partial<GateDeps> = {}) => {
  const calls = { exec: 0, made: 0, removed: 0 };
  const d: GateDeps = {
    ...deps(env), stockEnabled: false, rightsPolicy: null,
    makeProbeDir: async () => { calls.made++; return "/p"; }, removeProbeDir: async () => { calls.removed++; },
    exec: async () => { calls.exec++; return { code: 0, stdout: '{"status":"probe-ok"}' }; }, ...over,
  };
  return { d, calls };
};

test("compuerta: legacy no lanza nada; con stock y sin política de derechos bloquea ANTES de la sonda", async () => {
  const l = gateDeps({}); assert.deepEqual(await montageGate(l.d), { ok: true, engine: "legacy" }); assert.equal(l.calls.exec, 0);
  const r = gateDeps(DIRECTOR_ENV, { stockEnabled: true });
  assert.deepEqual(codes(await montageGate(r.d)), ["DIRECTOR_RIGHTS_UNAVAILABLE"]); assert.equal(r.calls.exec, 0);
  const cfg = gateDeps(DIRECTOR_ENV, { onPath: () => false });
  assert.deepEqual(codes(await montageGate(cfg.d)), ["DIRECTOR_ISOLATION_MISSING"]); assert.equal(cfg.calls.exec, 0);
});

test("compuerta: la sonda funcional decide; su carpeta se borra siempre; error de lanzamiento → bloqueado", async () => {
  const ok = gateDeps(DIRECTOR_ENV); const c = await montageGate(ok.d);
  assert.ok(c.ok && c.engine === "director"); assert.deepEqual(ok.calls, { exec: 1, made: 1, removed: 1 });
  for (const res of [{ code: 70, stdout: "" }, { code: 0, stdout: "basura" }, { code: 3, stdout: '{"status":"probe-failed","failed":["adaptador_legible"]}' }]) {
    const g = gateDeps(DIRECTOR_ENV, { exec: async () => res }); const out = await montageGate(g.d);
    assert.deepEqual(codes(out), ["DIRECTOR_ISOLATION_PROBE_FAILED"]); assert.equal(g.calls.removed, 1);
  }
  const boom = gateDeps(DIRECTOR_ENV, { exec: async () => { throw new Error("spawn"); } });
  assert.deepEqual(codes(await montageGate(boom.d)), ["DIRECTOR_ISOLATION_PROBE_FAILED"]); assert.equal(boom.calls.removed, 1);
  assert.match((parseProbeOutput(3, '{"status":"probe-failed","failed":["adaptador_legible"]}') as { error: { message: string } }).error.message, /adaptador_legible/);
  assert.equal(parseProbeOutput(1, '{"status":"probe-ok"}').ok, false, "probe-ok con código ≠ 0 no cuenta");
});

test("derechos: solo desde una política explícita; pageUrl/crédito quedan como procedencia, nunca como permiso", () => {
  const sin = directorRequest(base({ shots: [null, { ...base().shots[1]!, pageUrl: "https://www.pexels.com/photo/1", sourceId: "pexels-photo-1" }] }));
  assert.ok(sin.ok); assert.deepEqual(sin.request.rights, {});
  assert.deepEqual(sin.request.provenance, [{ asset: "medios/escena-2.mp4", provider: "pexels", sourceId: "pexels-photo-1", pageUrl: "https://www.pexels.com/photo/1", credit: "Pexels",
    derivative: "foto animada por el worker (renderPhotoFfmpeg)", size: 5, sha256: "b".repeat(64) }]);
  const seen: unknown[] = [];
  const policy: RightsPolicy = { id: "politica-prueba", version: "0", basisFor: (p) => { seen.push(p.asset); return p.sourceId ? { status: "cleared", basis: `fixture de prueba ${p.sourceId}` } : null; } };
  const con = directorRequest(base({ shots: [null, { ...base().shots[1]!, sourceId: "pexels-photo-1" }] }), policy);
  assert.ok(con.ok); assert.deepEqual(con.request.rights, { "medios/escena-2.mp4": { status: "cleared", basis: "fixture de prueba pexels-photo-1" } }); assert.deepEqual(seen, ["medios/escena-2.mp4"]);
});
