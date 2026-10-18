/**
 * Characterization probes for OPEN defects, not a release acceptance suite.
 * A passing probe confirms the named defect exists on the audited revision.
 * Real route/business code; fake auth, database, provider and billing adapters.
 * Run: node --experimental-test-module-mocks --import tsx --test scripts/audits/script-recovery-probes.test.ts
 * Replace these expectations with acceptance regressions when each issue is fixed.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakeSupabase } from "../simulator/lib/fake-supabase";
import type { GeneratedScript } from "../../src/lib/providers/types";
import type { ScriptOpRow } from "../../src/lib/supply/script-intent";

const db = createFakeSupabase({ signedUrlBase: "https://synthetic.invalid" });
let authFailure = false;
const USER = "audit-owner", ID = "audit-request";
const fixture = (): GeneratedScript => ({ title: "Synthetic script", segments: [0, 1, 2].map(i => ({
  text: Array.from({ length: i === 2 ? 27 : 28 }, (_, j) => `word${i}x${j}`).join(" "),
  visualQuery: `view ${i}`, energy: "medium", emphasisWords: [],
})) });
let replacement = fixture().segments[0];
function replaceModule(file: string, namedExports: Record<string, unknown>) {
  mock.module(pathToFileURL(path.join(process.cwd(), file)).href, { namedExports });
}
replaceModule("src/lib/supabase/service.ts", { createServiceClient: () => db.client });
replaceModule("src/lib/supabase/server.ts", { createClient: async () => {
  if (authFailure) throw new Error("synthetic auth unavailable");
  return { auth: { getUser: async () => ({ data: { user: { id: USER } } }) } };
} });
replaceModule("src/lib/supply/server.ts", { supplyGuardRequired: () => false });
replaceModule("src/lib/billing/quota.ts", { assertCanGenerate: async () => ({ allowed: true }) });
replaceModule("src/lib/billing/usage.ts", { recordScriptCall: async () => {} });
replaceModule("src/lib/providers/script/index.ts", { getScriptProvider: () => ({
  name: "anthropic", generateScript: async () => fixture(), regenerateScene: async () => replacement,
}) });
globalThis.fetch = async () => { throw new Error("External network forbidden in script audit"); };

function seed() {
  db.table("video_requests").splice(0);
  db.table("video_requests").push({ id: ID, user_id: USER, status: "script_ready", render_attempts: 0,
    script_json: fixture(), topic: "Synthetic castle construction", style: "Educativo", mode: "reel",
    duration_seconds: 30, language: "es", recorded_audio_path: null });
  return db.table("video_requests")[0];
}
const context = () => ({ params: Promise.resolve({ id: ID }) });
const request = (method: string, body: unknown) => new Request("https://synthetic.invalid/script", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

async function harness() {
  const { memoryLedgerStore } = await import("../../src/lib/production-intelligence/ledger");
  const { memoryResultStore } = await import("../../src/lib/paid-calls/result-store");
  const { currentSupplyScope, withScriptGenerationContext, guardScriptLedgerCall } = await import("../../src/lib/supply/anthropic");
  const store = memoryLedgerStore(), results = memoryResultStore();
  let calls = 0;
  const rows = async (): Promise<ScriptOpRow[]> => [...store.ops.values()].map(o => ({
    status: o.status, shot_id: o.shotId, updated_at: o.updatedAt, idempotency_key: o.idempotencyKey,
  }));
  const paid = async (step: string, outcome: () => Promise<GeneratedScript> = async () => fixture()) => (await guardScriptLedgerCall({ store, results }, currentSupplyScope()!,
    { model: "synthetic", max_tokens: 2000, step }, .05, () => .01,
    async () => { calls++; return outcome(); })).result;
  const generation = <T>(fn: () => Promise<T>) => withScriptGenerationContext(ID, fn, { guard: true, load: rows, store });
  return { store, results, rows, paid, generation, calls: () => calls };
}

test("OPEN R1: final save failure followed by retry pays again despite stored result", async () => {
  const h = await harness();
  const { runScriptGeneration } = await import("../../src/lib/video/script-generation");
  const { ScriptPersistenceError } = await import("../../src/lib/video/script-persistence");
  const generate = () => h.generation(() => h.paid("initial"));
  await assert.rejects(runScriptGeneration({ generate, persist: async () => { throw new ScriptPersistenceError(500); }, guard: true, loadRows: h.rows }));
  assert.equal(h.results.objects.size, 1, "already-paid result exists before retry");
  const retry = await runScriptGeneration({ generate, persist: async () => {}, guard: true, loadRows: h.rows });
  assert.equal(retry.status, 200);
  assert.equal(h.calls(), 2, "DEFECT: retry should reuse the first result");
  assert.deepEqual([...h.store.ops.values()].map(o => o.shotId.split(":")[1]), ["gen-0", "gen-1"]);
});

test("OPEN R2: another generation enters between a settled response and its length correction", async () => {
  const h = await harness();
  let release!: () => void, reached!: () => void;
  const pause = new Promise<void>(r => { release = r; });
  const ready = new Promise<void>(r => { reached = r; });
  const a = h.generation(async () => { await h.paid("initial"); reached(); await pause; return h.paid("correction"); });
  await ready;
  const b = await h.generation(() => h.paid("initial"));
  assert.ok(b);
  release(); await a;
  assert.equal(h.calls(), 3, "DEFECT: second generation was admitted before first completed");
  assert.deepEqual([...h.store.ops.values()].map(o => o.shotId.split(":")[1]), ["gen-0", "gen-1", "gen-0"]);
});

test("OPEN R3: failed full regeneration deletes an already approved script", async () => {
  const { runScriptGeneration } = await import("../../src/lib/video/script-generation");
  const { ScriptQualityError } = await import("../../src/lib/video/script-quality");
  const row: Record<string, unknown> = { status: "script_ready", script_json: fixture() };
  const result = await runScriptGeneration({ generate: async () => { throw new ScriptQualityError({ ok: false, issue: "word_count_out_of_range", detail: "synthetic" }); },
    persist: async patch => { Object.assign(row, patch); }, guard: true, loadRows: async () => [] });
  assert.equal(result.status, 500);
  assert.equal(row.script_json, null, "DEFECT: approved version should remain recoverable");
});

test("OPEN R4: real PATCH accepts stale-tab overwrite because it has no client version", async () => {
  const { PATCH } = await import("../../src/app/api/generate/[id]/script/route");
  const row = seed();
  const staleTab = fixture(), currentTab = fixture();
  currentTab.segments[0].text = "New edit in tab A";
  assert.equal((await PATCH(request("PATCH", currentTab), context())).status, 200);
  staleTab.segments[1].text = "Different edit in stale tab B";
  assert.equal((await PATCH(request("PATCH", staleTab), context())).status, 200);
  assert.equal((row.script_json as GeneratedScript).segments[0].text, fixture().segments[0].text,
    "DEFECT: successful tab A edit was silently lost");
});

test("OPEN R5: real PATCH throws on a null segment instead of returning a typed 400", async () => {
  const { PATCH } = await import("../../src/app/api/generate/[id]/script/route");
  seed();
  await assert.rejects(PATCH(request("PATCH", { title: "x", segments: [null] }), context()), TypeError);
});

test("OPEN R6: real PATCH accepts a non-string title and blank narration", async () => {
  const { PATCH } = await import("../../src/app/api/generate/[id]/script/route");
  const row = seed();
  const response = await PATCH(request("PATCH", { title: { wrong: true }, segments: [{ text: "", visualQuery: "" }] }), context());
  assert.equal(response.status, 200);
  assert.deepEqual((row.script_json as GeneratedScript).title, { wrong: true });
});

test("OPEN R7: real scene route accepts narration that makes the script fail its word budget", async () => {
  const { POST } = await import("../../src/app/api/generate/[id]/script/regenerate-scene/route");
  const { checkScriptQuality } = await import("../../src/lib/video/script-quality");
  seed();
  replacement = { ...fixture().segments[0], text: Array.from({ length: 150 }, () => "word").join(" "), visualQuery: "new unique view" };
  const response = await POST(request("POST", { sceneIndex: 0 }), context());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(checkScriptQuality(body.script, { topic: "Synthetic castle construction", targetWords: 83, providerName: "anthropic" }), {
    ok: false, issue: "word_count_out_of_range", detail: "El guion tiene 205 palabras, muy lejos del objetivo (~83).",
  });
});

test("OPEN R8: real POST auth setup fails outside the JSON error boundary", async () => {
  const { POST } = await import("../../src/app/api/generate/[id]/script/route");
  authFailure = true;
  try { await assert.rejects(POST(request("POST", {}), context()), /synthetic auth unavailable/); }
  finally { authFailure = false; }
});

test("OPEN R9: admission HTTP failures become uncertain and block the request in the current code", async () => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  for (const [status, type] of [[401, "authentication_error"], [403, "permission_error"], [429, "rate_limit_error"], [529, "overloaded_error"]] as const) {
    const h = await harness();
    const error = Anthropic.APIError.generate(status, { type: "error", error: { type, message: "synthetic admission rejection" } }, undefined, new Headers());
    await assert.rejects(h.generation(() => h.paid("initial", async () => { throw error; })));
    assert.equal([...h.store.ops.values()][0].status, "RECONCILIATION_REQUIRED");
    await assert.rejects(h.generation(() => h.paid("initial")));
    assert.equal(h.calls(), 1, `${status}: request is blocked until operator intervention; T32 is not integrated`);
  }
});

test("OPEN R10: lost HTTP reply recommends retry and the generation context pays again", async () => {
  const h = await harness();
  const { runScriptGeneration } = await import("../../src/lib/video/script-generation");
  const { safeParseJsonResponse } = await import("../../src/lib/http/safe-json");
  const row: Record<string, unknown> = { status: "pending", script_json: null };
  const post = () => runScriptGeneration({ generate: () => h.generation(() => h.paid("initial")),
    persist: async patch => { Object.assign(row, patch); }, guard: true, loadRows: h.rows });
  assert.equal((await post()).status, 200);
  const lost = await safeParseJsonResponse(new Response("", { status: 502 }));
  assert.equal(lost.ok, false);
  if (!lost.ok) assert.match(lost.error, /Intenta de nuevo/);
  assert.equal(row.status, "script_ready");
  // POST /script explicitly admits script_ready, and receives no client operation ID.
  assert.equal((await post()).status, 200);
  assert.equal(h.calls(), 2, "DEFECT: a delivery retry is indistinguishable from explicit regeneration");
});

test("CONTROL: real PATCH rejects another owner's request before modifying it", async () => {
  const { PATCH } = await import("../../src/app/api/generate/[id]/script/route");
  const row = seed(); row.user_id = "different-owner";
  const before = structuredClone(row);
  assert.equal((await PATCH(request("PATCH", fixture()), context())).status, 403);
  assert.deepEqual(row, before);
});
