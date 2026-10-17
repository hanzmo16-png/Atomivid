// Recorrido REAL de produce() del worker con dependencias inyectadas (sin Supabase, sin proveedores, sin red):
// cada bloqueo conocido del motor Director debe ocurrir antes de la narración y de la búsqueda de stock.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { produce, type ProduceInject } from "./podcast-video-worker";
import { DIRECTOR_FILES } from "../src/lib/podcast/montage-engine";

const DIR = "/opt/director";
const RUNNER = path.resolve("scripts/podcast-director-step.cjs");
const PRESENT = new Set([...Object.values(DIRECTOR_FILES).map((f) => path.join(DIR, f)), RUNNER, "/proc/self/fd"]);
const DIRECTOR_ENV = { PODCAST_MONTAGE_ENGINE: "director", PODCAST_DIRECTOR_DIR: DIR, PODCAST_DIRECTOR_UID: "1500" };
const ENV_KEYS = ["PODCAST_MONTAGE_ENGINE", "PODCAST_DIRECTOR_DIR", "PODCAST_DIRECTOR_UID", "PEXELS_API_KEY", "PODCAST_TOKEN_FILE", "DIRECTOR_PAUSA_EN", "DIRECTOR_PAUSA_DIR"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const setEnv = (e: Record<string, string>) => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, e); };

const EP_ID = "11111111-2222-3333-4444-555555555555";
/** Episodio TTS aún sin narrar, con un vídeo en cola: el primer paso de pago sería runGeneration. */
const episode = () => ({ id: EP_ID, user_id: "u", title: "t", language: "es", source: "tts", script: "x".repeat(500), voice_id: "v", status: "draft",
  estimated_usd: 0.5, budget_usd: 5, video_status: "queued", video_run_token: "tok", video_attempts: 1, duration_seconds: null, audio_path: null });

function harness(over: { probe?: { code: number; stdout: string } | Error; onPath?: boolean; uid?: number; exists?: (p: string) => boolean } = {}) {
  const calls = { narration: 0, stock: 0, exec: [] as string[][], updates: [] as Record<string, unknown>[], notices: 0 };
  const ep = episode();
  const query = { eq: () => query, single: async () => ({ data: ep }), maybeSingle: async () => ({ data: null, error: null }) };
  const service = {
    from: () => ({
      select: () => query,
      update: (patch: Record<string, unknown>) => { calls.updates.push(patch); const q = { eq: () => q, select: async () => ({ data: [{ id: EP_ID }] }) }; return q; },
    }),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: "fixture: sin audio" } }) }) },
  };
  const inject: ProduceInject = {
    service: service as never,
    runGeneration: (async () => { calls.narration++; return { error: "fixture: narración detenida por la prueba", status: 500 }; }) as never,
    buildSceneShots: (async () => { calls.stock++; return []; }) as never,
    pilot: {
      productionSpend: (async () => ({ spentUsd: 0, uncertainUsd: 0, uncertain: 0 })) as never,
      pendingNarration: (async () => ({ usd: 0.5, chunks: 1 })) as never,
      readRunBudget: (async () => ({ available: true, value: 5 })) as never,
      recordNotice: (async () => { calls.notices++; return null; }) as never,
    },
    gate: {
      uid: over.uid ?? 1500, exists: over.exists ?? ((p) => PRESENT.has(p)), onPath: (c) => c === "bwrap" && over.onPath !== false,
      makeProbeDir: async () => mkdtempSync(path.join(tmpdir(), "probe-test-")), removeProbeDir: async () => undefined,
      exec: async (cmd, args) => {
        calls.exec.push([cmd, ...args]);
        if (over.probe instanceof Error) throw over.probe;
        return over.probe ?? { code: 0, stdout: '{"status":"probe-ok","checks":[]}\n' };
      },
    },
  };
  const last = () => calls.updates[calls.updates.length - 1] ?? {};
  return { inject, calls, last };
}

async function run(env: Record<string, string>, over: Parameters<typeof harness>[0] = {}) {
  setEnv(env);
  const h = harness(over);
  await produce(EP_ID, h.inject);
  process.exitCode = 0; // produce marca exitCode=1 al bloquear; aquí es el resultado esperado de la prueba
  return h;
}

const blockedBefore = (h: Awaited<ReturnType<typeof run>>, code: RegExp) => {
  assert.equal(h.calls.narration, 0, "0 llamadas al narrador");
  assert.equal(h.calls.stock, 0, "0 búsquedas de stock");
  assert.equal(h.last().video_status, "blocked");
  assert.match(String(h.last().video_error), code);
};

test("legacy (sin variable): no lanza la sonda y llega a la narración como antes", async () => {
  const h = await run({});
  assert.equal(h.calls.exec.length, 0); assert.equal(h.calls.narration, 1);
  assert.equal(h.last().video_status, "failed", "la narración simulada falla y el episodio queda failed, igual que en la base");
});

test("H1: Director con stock y sin política de derechos → bloqueado antes de narrar (sin sonda ni gasto)", async () => {
  const h = await run({ ...DIRECTOR_ENV, PEXELS_API_KEY: "fixture-no-se-usa" });
  blockedBefore(h, /DIRECTOR_RIGHTS_UNAVAILABLE/); assert.equal(h.calls.exec.length, 0);
});

test("H2: bwrap ausente, root, módulo ausente o variable ausente → bloqueado antes de narrar", async () => {
  blockedBefore(await run(DIRECTOR_ENV, { onPath: false }), /DIRECTOR_ISOLATION_MISSING/);
  blockedBefore(await run({ ...DIRECTOR_ENV, PODCAST_DIRECTOR_UID: "0" }, { uid: 0 }), /DIRECTOR_UID_NOT_DEDICATED/);
  blockedBefore(await run(DIRECTOR_ENV, { exists: (p) => PRESENT.has(p) && !p.endsWith("worker-adapter.js") }), /DIRECTOR_MODULE_MISSING/);
  blockedBefore(await run({ PODCAST_MONTAGE_ENGINE: "director" }), /DIRECTOR_ENV_MISSING/);
});

test("H2: la sonda funcional falla (bwrap no ejecutable, namespaces denegados, paquete oculto, lanzamiento imposible) → bloqueado antes de narrar", async () => {
  for (const probe of [
    { code: 70, stdout: "" }, // ejecutar_aislado.sh: falta bwrap / no ejecutable
    { code: 1, stdout: "" }, // bwrap: "No permissions to creating new namespace" (stderr)
    { code: 126, stdout: "" }, // binario sin permiso de ejecución
    { code: 3, stdout: '{"status":"probe-failed","failed":["adaptador_legible"],"checks":[]}\n' }, // paquete tapado por el tmpfs de /tmp
    { code: 3, stdout: '{"status":"probe-failed","failed":["solo_lectura_fuera_del_trabajo"],"checks":[]}\n' }, // no está aislado de verdad
    new Error("spawn bash ENOENT"),
  ]) blockedBefore(await run(DIRECTOR_ENV, { probe }), /DIRECTOR_ISOLATION_PROBE_FAILED/);
});

test("caso válido: con barreras y sonda correctas el worker pasa la compuerta y llega a la narración; la sonda monta el paquete en solo lectura", async () => {
  const h = await run(DIRECTOR_ENV);
  assert.equal(h.calls.narration, 1);
  assert.equal(h.calls.exec.length, 1);
  const args = h.calls.exec[0];
  assert.equal(args[0], "bash"); assert.equal(args[1], path.join(DIR, DIRECTOR_FILES.isolate));
  assert.ok(args.includes("--probe"));
  const ro = args.flatMap((a, i) => (a === "--ro" ? [args[i + 1]] : []));
  assert.ok(ro.includes(DIR) && ro.includes(path.dirname(RUNNER)), "paquete y runner visibles dentro del aislamiento aunque estén bajo /tmp");
  assert.ok(args.indexOf("--") > args.lastIndexOf("--ro"), "los montajes van antes de la orden");
});

// Con el paquete real compilado (opcional): la sonda real fuera de bwrap detecta que NO hay aislamiento.
const REAL = process.env.PODCAST_DIRECTOR_TEST_DIR?.trim();
const real = !!REAL && existsSync(path.join(REAL, DIRECTOR_FILES.adapter));
test("sonda real sin bwrap: lee el adaptador pero detecta escritura fuera del trabajo → probe-failed", { skip: !real && "sin PODCAST_DIRECTOR_TEST_DIR" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const probeDir = mkdtempSync(path.join(tmpdir(), "probe-real-"));
  const p = spawnSync(process.execPath, [RUNNER, "--probe", REAL!, probeDir], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv });
  const j = JSON.parse(p.stdout);
  assert.equal(p.status, 3);
  assert.ok(j.checks.includes("adaptador_legible") && j.checks.includes("escritura_en_trabajo"));
  assert.ok(j.failed.includes("solo_lectura_fuera_del_trabajo"), "fuera de bwrap el paquete es escribible: la sonda no da verde");
  const hidden = spawnSync(process.execPath, [RUNNER, "--probe", path.join(probeDir, "no-existe"), probeDir], { encoding: "utf8" });
  assert.equal(hidden.status, 3); assert.ok(JSON.parse(hidden.stdout).failed.includes("adaptador_legible"));
});
