import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedRead, readPort, publicAnalysis } from "./lunar-readonly-diagnostic";
import { TARGET, diagnoseVisualPlanBlock } from "./diagnose-visual-plan-block";
import { analyzeVisualPlan } from "../src/lib/video/long-form/visual-plan-analysis";

test("bounded reads cancel oversized declared and streamed bodies", async () => {
  await assert.rejects(boundedRead(new Response("large", { headers: { "content-length": "5" } }), 4));
  await assert.rejects(boundedRead(new Response("large"), 4));
  assert.equal(Buffer.from(await boundedRead(new Response("ok"), 4)).toString(), "ok");
});

test("unexpected environment and object references fail before any network call", async () => {
  let calls = 0;
  const fake = (async () => { calls++; return new Response("[]"); }) as typeof fetch;
  assert.throws(() => readPort("https://example.com", "synthetic", fake));
  const port = readPort("https://msyxczcdjhbednmfzxqq.supabase.co", "synthetic", fake);
  await assert.rejects(port.job("different"));
  await assert.rejects(port.ledgerRow(TARGET.operation));
  await assert.rejects(port.download("another-object"));
  assert.equal(calls, 0);
});

test("changed job stops after one exact GET and rejects redirects", async () => {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const fake = (async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return new Response(JSON.stringify([{ id: TARGET.jobId, status: "completed", error_code: "d9d6cb8f" }]));
  }) as typeof fetch;
  await assert.rejects(diagnoseVisualPlanBlock(readPort("https://msyxczcdjhbednmfzxqq.supabase.co", "synthetic", fake), {}));
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("id"), `eq.${TARGET.jobId}`);
  assert.equal(calls[0].options?.method, "GET");
  assert.equal(calls[0].options?.redirect, "error");
});

test("public report omits arbitrary keys, narration and anchor ids", () => {
  const report = analyzeVisualPlan({ visuals: [{ PRIVATE_UNKNOWN_KEY: "PRIVATE_VALUE", excerptId: "PRIVATE_EXCERPT" }] },
    [{ narration: "PRIVATE_NARRATION has at least five words here." }], 0, { referenceContract: true, cinematic: false });
  const output = JSON.stringify(publicAnalysis(report));
  assert.doesNotMatch(output, /PRIVATE_|[0-9a-f]{16}:b/);
  assert.ok(output.length < 4000);
  assert.equal(publicAnalysis(report).invalidSceneCount, 1);
});
