/**
 * T36 C1 — the render worker has one CLI entry; its local fixture mode opens only when every local condition holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DISPATCH_INTERCEPTED_MARK, LOCAL_FIXTURE_FLAG, localFixtureRefusal, providerRefusal, runRenderWorkerCli } from "./worker-cli";

const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", GH_WORKER_TOKEN: "local-fake-not-a-token" };
const FIX = { voice: "fixture", footage: "fixture", music: "fixture" };

test("modo fixture local: abre solo si TODAS las condiciones locales se cumplen; cualquier condición no local aborta", () => {
  assert.equal(localFixtureRefusal(LOCAL, FIX, true), null);
  assert.equal(localFixtureRefusal({ ...LOCAL, GH_WORKER_TOKEN: undefined }, FIX, true), null, "sin token también es local");
  const cases: [Record<string, string | undefined>, typeof FIX, boolean, string][] = [
    [{ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }, FIX, true, "LOCAL_FIXTURE_SUPABASE_NOT_LOOPBACK"],
    [{ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1.evil.example" }, FIX, true, "LOCAL_FIXTURE_SUPABASE_NOT_LOOPBACK"],
    [{ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: undefined }, FIX, true, "LOCAL_FIXTURE_SUPABASE_NOT_LOOPBACK"],
    [LOCAL, { ...FIX, voice: "elevenlabs" }, true, "LOCAL_FIXTURE_REAL_PROVIDER"],
    [LOCAL, { ...FIX, footage: "pexels-video-first" }, true, "LOCAL_FIXTURE_REAL_PROVIDER"],
    [{ ...LOCAL, GH_WORKER_TOKEN: "github_pat_xxx" }, FIX, true, "LOCAL_FIXTURE_REAL_GITHUB_TOKEN"],
    [LOCAL, FIX, false, "LOCAL_FIXTURE_DISPATCH_NOT_INTERCEPTED"],
    [{ ...LOCAL, GITHUB_ACTIONS: "true" }, FIX, true, "LOCAL_FIXTURE_INSIDE_GITHUB_ACTIONS"],
    [{ ...LOCAL, GITHUB_EVENT_NAME: "repository_dispatch" }, FIX, true, "LOCAL_FIXTURE_INSIDE_GITHUB_ACTIONS"],
  ];
  for (const [env, names, intercepted, code] of cases) assert.equal(localFixtureRefusal(env, names, intercepted), code, JSON.stringify({ env, names, intercepted }));
});

test("reglas de producción intactas: voz/material nunca fixture; música fixture solo fuera de repository_dispatch", () => {
  assert.equal(providerRefusal({}, { voice: "elevenlabs", footage: "pexels-video-first", music: "manifest" }), null);
  assert.equal(providerRefusal({}, { voice: "fixture", footage: "pexels-video-first", music: "manifest" }), "WORKER_FIXTURE_VOICE_OR_FOOTAGE");
  assert.equal(providerRefusal({}, { voice: "elevenlabs", footage: "fixture", music: "manifest" }), "WORKER_FIXTURE_VOICE_OR_FOOTAGE");
  assert.equal(providerRefusal({ GITHUB_EVENT_NAME: "repository_dispatch" }, { voice: "elevenlabs", footage: "pexels-video-first", music: "fixture" }), "WORKER_FIXTURE_MUSIC_ON_USER_RENDER");
  assert.equal(providerRefusal({ GITHUB_EVENT_NAME: "workflow_dispatch" }, { voice: "elevenlabs", footage: "pexels-video-first", music: "fixture" }), null);
});

test("el CLI rechaza sin tocar la base: sin REQUEST_ID, o modo fixture con Supabase remota / sin interceptor", async () => {
  await assert.rejects(runRenderWorkerCli({}), { name: "WorkerRefusal", message: "REQUEST_ID_MISSING" });
  const g = globalThis as Record<string, unknown>;
  delete g[DISPATCH_INTERCEPTED_MARK];
  await assert.rejects(runRenderWorkerCli({ REQUEST_ID: "x", [LOCAL_FIXTURE_FLAG]: "1", ...LOCAL, VOICE_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture" }), { message: "LOCAL_FIXTURE_DISPATCH_NOT_INTERCEPTED" });
});

test("un solo punto de entrada: render-worker.ts y el recorrido local ejecutan la misma función; no hay wrapper paralelo", () => {
  const entry = readFileSync("scripts/render-worker.ts", "utf8");
  assert.match(entry, /runRenderWorkerCli\(process\.env\)/);
  assert.doesNotMatch(entry, /runRenderJob/, "la lógica vive en worker-cli.ts");
  const walk = readFileSync("scripts/qa/b3/director-walkthrough.mjs", "utf8");
  assert.match(walk, /"scripts\/render-worker\.ts"/, "el worker del E2E es el entrypoint productivo");
  assert.ok(!existsSync("scripts/qa/b3/run-worker.ts"), "el wrapper paralelo que solo llamaba a runRenderJob ya no existe");
  assert.equal(walk.match(/run-worker\.ts/g)?.length, 1, "solo el ROJO opcional (--legacy-worktree) ejecuta el wrapper del árbol ANTERIOR");
  assert.match(readFileSync(".github/workflows/render.yml", "utf8"), /npx tsx scripts\/render-worker\.ts/);
});
