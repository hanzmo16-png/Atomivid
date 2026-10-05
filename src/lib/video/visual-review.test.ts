import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryResultStore, sha256Hex } from "@/lib/paid-calls/result-store";
import { paidCallKey } from "@/lib/paid-calls/gate";
import type { LedgerStore, PaidOperation } from "@/lib/production-intelligence/ledger";
import { reviewVisual, REVIEW_MODEL, REVIEW_OUTPUT_TOKEN_LIMIT, REVIEW_RESERVATION_USD, REVIEW_FORMAT_INSTRUCTION, REVIEW_REASONS } from "./visual-review";
import type { VisualIntent } from "./visual-intent";

const intent: VisualIntent = { source: "illustration", subject: "grey alien figure", mustShow: ["large head", "large black eyes"], mustNotShow: ["lamp"], imagePrompt: "A grey alien figure with a large head and large black eyes." };
const verdict = { subjectPresent: true, allRequiredTraitsPresent: true, forbiddenSubstitutePresent: false, unrelatedTextOrWatermark: false, subjectClear: true, compositionAcceptable: true, visualArtifactsPresent: false, confidence: 0.95, reason: "Alien figure visible." };
function ledger() {
  const rows = new Map<string, PaidOperation>();
  const port: LedgerStore = { get: async key => rows.get(key) ?? null, insert: async op => { if (rows.has(op.idempotencyKey)) return false; rows.set(op.idempotencyKey, op); return true; }, update: async (key, expected, patch) => { const row = rows.get(key); if (!row || row.status !== expected) return false; rows.set(key, { ...row, ...patch }); return true; } };
  return { port, rows };
}

test("vision receives image pixels plus literal requirements; retries reuse the persisted verdict at zero extra calls", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port, rows } = ledger(); const results = memoryResultStore(); let calls = 0;
    const fetcher: typeof fetch = async (_url, options) => {
      calls++; const body = JSON.parse(String(options?.body));
      assert.equal(body.model, REVIEW_MODEL); assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 1024);
      for (const field of ["subjectClear", "compositionAcceptable", "visualArtifactsPresent"]) assert.ok(body.text.format.schema.required.includes(field));
      assert.equal(body.input[0].content[1].detail, "high");
      assert.match(body.instructions, /Judge EVERY supplied view/);
      assert.equal([...rows.values()].filter(row => row.status === "SUBMITTED").length, 1);
      assert.match(body.instructions, /ONLY one compact JSON/);
      assert.deepEqual(body.text.format.schema.properties.reason.enum, REVIEW_REASONS);
      assert.match(body.input[0].content[0].text, /grey alien/);
      assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 900, output_tokens: 100 }, output: [{ content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] }), { status: 200 });
    };
    const args = { service: {} as SupabaseClient, requestId: "request", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3, ledger: port, results, fetcher, frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"] };
    assert.equal((await reviewVisual(args)).accepted, true);
    const reused = await reviewVisual(args); assert.equal(reused.reused, true); assert.equal(reused.costUsd, 0); assert.equal(calls, 1);
    const changed = await reviewVisual({ ...args, intent: { ...intent, subject: "another alien" } });
    assert.equal(changed.reused, false); assert.equal(calls, 2);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("bounded formatting still reuses legacy paid reviews and blocks legacy uncertainty without a new key", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port, rows } = ledger(), results = memoryResultStore(); let calls = 0, instructions = "";
    const args = { service: {} as SupabaseClient, requestId: "request", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3,
      ledger: port, results, frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"],
      fetcher: (async (_url, options) => { calls++; instructions = JSON.parse(String(options?.body)).instructions;
        return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] }), { status: 200 }); }) as typeof fetch };
    await reviewVisual(args);
    const legacyKey = paidCallKey({ projectId: "request", shotId: "visual-review:scene-0", provider: "openai", model: REVIEW_MODEL,
      method: "visual_relevance_review", reservedUsd: 0.005,
      inputFingerprint: { policy: "literal-visual-quality/2", instructionsSha256: sha256Hex(Buffer.from(instructions.replace(REVIEW_FORMAT_INSTRUCTION, ""))),
        responseContract: { reasonMaxCharacters: 240, qualityFieldsRequired: true }, intent, narration: "A grey alien",
        mediaSha256: sha256Hex(Buffer.from("asset")), frameSha256: [sha256Hex(Buffer.from("data:image/jpeg;base64,cGl4ZWxz"))] } });
    const legacy = { ...[...rows.values()][0], idempotencyKey: legacyKey };
    rows.clear(); rows.set(legacyKey, legacy);
    assert.equal((await reviewVisual(args)).reused, true); assert.equal(calls, 1);
    legacy.status = "RECONCILIATION_REQUIRED";
    await assert.rejects(reviewVisual(args), /reconcile/);
    assert.equal(rows.size, 1); assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("an incomplete token-limited response never passes, stays private, and cannot be purchased again", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port, rows } = ledger(), results = memoryResultStore(); let calls = 0;
    // Even apparently valid output is not trustworthy when its response is incomplete.
    const response = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 900, output_tokens: 512 },
      output: [{ content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] };
    const args = { service: {} as SupabaseClient, requestId: "r", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3,
      ledger: port, results, frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"],
      fetcher: (async () => { calls++; return new Response(JSON.stringify(response), { status: 200 }); }) as typeof fetch };
    await assert.rejects(reviewVisual(args), /límite de respuesta/);
    assert.equal([...rows.values()][0].status, "RECONCILIATION_REQUIRED");
    assert.equal(results.objects.size, 1);
    assert.deepEqual(JSON.parse([...results.objects.values()][0].toString()), response);
    await assert.rejects(reviewVisual(args), /reconcile/);
    assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("the expanded response allowance fits six views when bounded and blocks oversize input before reservation", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port, rows } = ledger(); let calls = 0;
    const args = { service: {} as SupabaseClient, requestId: "r", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "video" as const, durationSeconds: 3,
      ledger: port, results: memoryResultStore(), frames: async () => Array(6).fill("data:image/jpeg;base64,cGl4ZWxz") as string[],
      fetcher: (async (_url, options) => {
        calls++; const body = JSON.parse(String(options?.body));
        const upperInputTokens = Buffer.byteLength(body.instructions + body.input[0].content[0].text) + 512 + 6 * Math.ceil(16 * 29 * 1.62);
        assert.equal(body.max_output_tokens, REVIEW_OUTPUT_TOKEN_LIMIT);
        assert.ok((upperInputTokens * 0.4 + body.max_output_tokens * 1.6) / 1_000_000 <= REVIEW_RESERVATION_USD);
        return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] }), { status: 200 });
      }) as typeof fetch };
    assert.equal((await reviewVisual(args)).accepted, true);
    await assert.rejects(reviewVisual({ ...args, narration: "a".repeat(2000) }), /supera la reserva/);
    assert.equal(calls, 1); assert.equal(rows.size, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("reservation failure blocks HTTP; uncertain HTTP never retries automatically", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port } = ledger(); let calls = 0;
    const args = { service: {} as SupabaseClient, requestId: "request", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3, results: memoryResultStore(), frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"], fetcher: (async () => { calls++; throw Error("connection cut"); }) as typeof fetch };
    await assert.rejects(reviewVisual({ ...args, ledger: { ...port, insert: async () => { throw Error("budget blocked"); } } }), /budget blocked/); assert.equal(calls, 0);
    await assert.rejects(reviewVisual({ ...args, ledger: port }), /connection cut/);
    await assert.rejects(reviewVisual({ ...args, ledger: port })); assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("long explanations do not discard a valid verdict and exact provider response is retained privately", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port } = ledger(), results = memoryResultStore();
    const response = { status: "completed", usage: { input_tokens: 900, output_tokens: 180 }, output: [{ content: [{ type: "output_text", text: JSON.stringify({ ...verdict, reason: "Visible subject and traits. ".repeat(25) }) }] }] };
    const result = await reviewVisual({ service: {} as SupabaseClient, requestId: "request", sceneIndex: 0, intent, narration: "A grey alien",
      buffer: Buffer.from("asset"), mediaType: "image", durationSeconds: 3, ledger: port, results,
      frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"], fetcher: (async (_url, options) => {
        const body = JSON.parse(String(options?.body)); assert.equal(body.text.format.schema.properties.reason.maxLength, 240);
        return new Response(JSON.stringify(response), { status: 200 });
      }) as typeof fetch });
    assert.equal(result.accepted, true); assert.equal(result.verdict.reason.length, 240);
    const raw = [...results.objects.entries()].find(([key]) => key.endsWith(".provider-response.json"));
    assert.ok(raw); assert.deepEqual(JSON.parse(raw[1].toString()), response);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("a relevant subject with poor clarity, bad framing or visual defects is rejected even at high confidence", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port } = ledger();
    const failures = [
      { subjectClear: false, reason: "The correct subject is heavily blurred." },
      { compositionAcceptable: false, reason: "The defining eyes leave the viewport at maximum zoom." },
      { visualArtifactsPresent: true, reason: "The correct humanoid has fused, duplicated arms." },
    ];
    for (const [sceneIndex, failure] of failures.entries()) {
      const result = await reviewVisual({ service: {} as SupabaseClient, requestId: "r", sceneIndex, intent,
        narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image", durationSeconds: 3, ledger: port, results: memoryResultStore(),
        frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"],
        fetcher: (async () => new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ ...verdict, confidence: 1, ...failure }) }] }] }), { status: 200 })) as typeof fetch });
      assert.equal(result.accepted, false); assert.equal(result.verdict.subjectPresent, true);
    }
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("an old relevance-only persisted verdict cannot pass or silently purchase a replacement", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port, rows } = ledger(), results = memoryResultStore(); let calls = 0;
    const args = { service: {} as SupabaseClient, requestId: "r", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3,
      ledger: port, results, frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"],
      fetcher: (async () => { calls++; return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] }), { status: 200 }); }) as typeof fetch };
    await reviewVisual(args);
    const row = [...rows.values()][0];
    assert.ok(row.resultRef);
    const legacy = { subjectPresent: true, allRequiredTraitsPresent: true, forbiddenSubstitutePresent: false, unrelatedTextOrWatermark: false, confidence: 1, reason: "Looks relevant." };
    await results.putJson(row.resultRef, legacy);
    await assert.rejects(reviewVisual(args), /stored result missing or invalid/);
    assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});
