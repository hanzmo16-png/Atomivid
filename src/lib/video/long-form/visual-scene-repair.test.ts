import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverVisualPlan, VISUAL_SCENE_REPAIR_MAX_TOKENS } from "./visual-scene-repair";
import { parseVisualPlan, ProductReferencedVisualsSchema } from "./documentary-script";
import { DocumentaryResponseError } from "./json-response";
import { narrationCatalog } from "./narration-catalog";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";

const beats = [{ narration: Array.from({ length: 192 }, (_, i) => `word${i}`).join(" ") }];
const catalog = narrationCatalog(beats);
const scene = (i: number) => ({ description: "Lunar surface with distant crater", motion: false, subject: "crater", excerptId: catalog[i].id });
const fixture = () => ({ visuals: [scene(0), { UNKNOWN_SYNTHETIC_KEY: "unknown data" }, ...[4, 6, 8, 10, 12, 14, 15].map(scene)] });
const message = (value: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] });
type Params = { model: string; max_tokens: number } & Record<string, unknown>;
const options = (value: unknown, send: (p: Params) => Promise<ReturnType<typeof message>>) => ({
  response: message(value), enabled: true,
  parse: (r: Parameters<typeof parseVisualPlan>[0]) => parseVisualPlan(r, { cinematic: false, referenceContract: true }),
  sceneSchema: ProductReferencedVisualsSchema.shape.visuals.element,
  catalog, context: JSON.stringify({ narration: beats[0].narration }), model: "claude-sonnet-5", send,
});

test("nine-entry incident: one replacement, eight scenes and original response preserved", async () => {
  const raw = fixture(), original = structuredClone(raw), requests: Params[] = [];
  const input = options(raw, async params => { requests.push(params); return message({ index: 1, scene: scene(1) }); });
  const result = await recoverVisualPlan(input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, VISUAL_SCENE_REPAIR_MAX_TOKENS);
  assert.equal(result.visuals.length, 9);
  for (const i of [0, 2, 3, 4, 5, 6, 7, 8]) assert.deepEqual(result.visuals[i], raw.visuals[i]);
  assert.deepEqual(raw, original);
  assert.deepEqual(input.response, message(original));
  assert.deepEqual(result.visuals[1], scene(1));
});

test("no retry permission, two invalid scenes, bad JSON or missing anchors never call the provider", async () => {
  let calls = 0;
  const send = async () => { calls++; return message({ index: 1, scene: scene(1) }); };
  await assert.rejects(recoverVisualPlan({ ...options(fixture(), send), enabled: false }));
  const two = fixture(); two.visuals[2] = { UNKNOWN_SYNTHETIC_KEY: "another" };
  await assert.rejects(recoverVisualPlan(options(two, send)));
  const missing = fixture(); delete (missing.visuals[0] as { excerptId?: string }).excerptId;
  await assert.rejects(recoverVisualPlan(options(missing, send)));
  await assert.rejects(recoverVisualPlan({ ...options(fixture(), send), response: { stop_reason: "end_turn", content: [{ type: "text", text: "{" }] } }));
  assert.equal(calls, 0);
});

test("invalid replacement, wrong index, extra fields and foreign or duplicate anchors fail once", async () => {
  for (const reply of [ {}, { index: 2, scene: scene(1) }, { index: 1, scene: {} },
    { index: 1, scene: scene(0) }, { index: 1, scene: scene(14) },
    { index: 1, scene: { ...scene(1), excerptId: "foreign" } },
    { index: 1, scene: scene(1), EXTRA_PRIVATE_FIELD: "secret" },
  ]) {
    let calls = 0;
    await assert.rejects(recoverVisualPlan(options(fixture(), async () => { calls++; return message(reply); })),
      error => error instanceof DocumentaryResponseError && !error.message.includes("PRIVATE"));
    assert.equal(calls, 1);
  }
});

test("valid plan and excessive reservation never make a new request", async () => {
  let calls = 0;
  const send = async () => { calls++; return message({ index: 1, scene: scene(1) }); };
  const valid = { visuals: [scene(0), scene(1)] };
  assert.deepEqual(await recoverVisualPlan(options(valid, send)), valid);
  await assert.rejects(recoverVisualPlan({ ...options(fixture(), send), context: "x".repeat(2000000) }));
  assert.equal(calls, 0);
});

test("existing ledger reuses the exact repair; uncertain results never resubmit", async () => {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let calls = 0;
  const send = async (params: Params) => (await guardPaidCall(store, {
    projectId: "synthetic-lunar", shotId: `script:documentary:${stableHash(params, 16)}`,
    provider: "anthropic", model: params.model, method: "generate_script", inputFingerprint: params, reservedUsd: 0.1,
  }, {
    async call({ key }) { calls++; const result = message({ index: 1, scene: scene(1) });
      const resultRef = `synthetic/${key}`; await results.putJson(resultRef, result); return { result, resultRef, costUsd: 0.01 }; },
    load: ref => results.getJson<ReturnType<typeof message>>(ref), maxRejectedRetries: 0,
  })).result;
  const first = await recoverVisualPlan(options(fixture(), send));
  assert.deepEqual(await recoverVisualPlan(options(fixture(), send)), first);
  assert.equal(calls, 1);
  const [key, operation] = [...store.ops][0];
  store.ops.set(key, { ...operation, status: "SUBMITTED", resultRef: null, committedUsd: null, providerJobId: null });
  await assert.rejects(recoverVisualPlan(options(fixture(), send)));
  assert.equal(calls, 1);
});
