import test from "node:test";
import assert from "node:assert/strict";
import { ScriptOutputError, requireScriptOutput } from "../video/script-output";
import { classifyScriptError, scriptErrorCode } from "../video/script-error";
import { isNoRetryScriptMessage } from "../video/script-retry";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { parseStoredScriptOutput, scriptCallBudget } from "../video/script-output";
import { guardScriptLedgerCall } from "../supply/anthropic";
import { memoryLedgerStore } from "../production-intelligence/ledger";
import { memoryResultStore } from "../paid-calls/result-store";

function script(words: number) {
  return { title: "Prueba", segments: Array.from({ length: 6 }, (_, i) => ({
    text: Array.from({ length: Math.floor(words / 6) + (i < words % 6 ? 1 : 0) }, (_, j) => `palabra${i}_${j}`).join(" "),
    visualQuery: `camera angle ${i}`,
  })) };
}

test("short script SDK requests reserve their existing budget for text, including corrections and scene edits", async () => {
  const originalFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "test", ANTHROPIC_API_KEY: "test-no-network", ANTHROPIC_SCRIPT_MODEL: "claude-sonnet-5", SUPPLY_GUARD_ENFORCED: "false" });
  delete process.env.VERCEL_ENV;
  const requests: Array<{ thinking?: unknown; max_tokens: number; messages: Array<{ content: string }> }> = [];
  const responses = [script(73), script(83), script(83).segments[0], null, '{"title":"cut', { title: "Invalid", segments: [{ text: "", visualQuery: "castle" }] }];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const output = responses.shift();
    return new Response(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: body.model,
      content: output ? [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }] : [],
      stop_reason: !output || typeof output === "string" ? "max_tokens" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: output ? 500 : 2000 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { generateScript, regenerateScene } = await import("./script");
    const input = { topic: "camera", style: "educational", durationSeconds: 30 };
    const result = await generateScript(input);
    assert.equal(result.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0), 83);
    assert.equal(requests.length, 2);
    assert.match(requests[1].messages[0].content, /73 palabras/);
    await regenerateScene({ ...input, script: result, sceneIndex: 0 });
    for (const r of requests) assert.deepEqual(r.thinking, { type: "disabled" });
    assert.deepEqual(requests.map(r => r.max_tokens), [2000, 2000, 500]);
    await assert.rejects(generateScript(input), (e: unknown) => e instanceof ScriptOutputError && e.reason === "output_limit");
    assert.equal(requests.length, 4, "empty output must not trigger another paid correction");
    await assert.rejects(generateScript({ ...input, durationSeconds: 60 }), (e: unknown) => e instanceof ScriptOutputError && e.reason === "output_limit");
    await assert.rejects(generateScript(input), (e: unknown) => e instanceof ScriptOutputError && e.reason === "invalid_schema");
    assert.equal(requests.length, 6, "nonempty truncation and schema failures must not trigger paid corrections");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});

test("incomplete output is diagnosed safely and does not offer repeated paid retries", () => {
  for (const reason of ["output_limit", "missing_output"] as const) {
    const error = new ScriptOutputError(reason);
    assert.equal(scriptErrorCode(error), reason === "output_limit" ? "script_output_limit" : "script_missing_output");
    assert.ok(isNoRetryScriptMessage(classifyScriptError(error, "0f950291")));
  }
  assert.throws(() => requireScriptOutput({ stop_reason: "max_tokens", parsed_output: script(83) }), ScriptOutputError);
  assert.throws(() => requireScriptOutput({ stop_reason: "end_turn", parsed_output: null }), ScriptOutputError);
  assert.deepEqual(requireScriptOutput({ stop_reason: "end_turn", parsed_output: script(83) }), script(83));
});

test("real SDK + ledger: truncated, malformed and refused replies retain raw output and usage, never become uncertain parse calls", async () => {
  const schema = z.object({ title: z.string().min(1) });
  const cases = [
    { stop: "max_tokens", text: '{"title":"cut', reason: "output_limit" },
    { stop: "end_turn", text: "{broken", reason: "invalid_json" },
    { stop: "end_turn", text: '{"title":42}', reason: "invalid_schema" },
    { stop: "refusal", text: "not JSON", reason: "refusal" },
    { stop: "end_turn", text: "", reason: "missing_output" },
  ];
  for (const c of cases) {
    const store = memoryLedgerStore(), results = memoryResultStore();
    let calls = 0;
    const client = new Anthropic({ apiKey: "fixture-not-a-key", maxRetries: 0, fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "fixture",
        stop_reason: c.stop, stop_sequence: null, content: [{ type: "text", text: c.text }],
        usage: { input_tokens: 100, output_tokens: 2000 },
      }), { headers: { "content-type": "application/json" } });
    } });
    const params = { model: "fixture", max_tokens: 2000, messages: [{ role: "user" as const, content: "fixture" }], output_config: { format: zodOutputFormat(schema) } };
    const scope = { projectId: "synthetic", intentId: "gen-0", claimBeforeCall: true };
    const paid = await guardScriptLedgerCall({ store, results }, scope, params, .047, () => .012, () => client.messages.create(params));
    assert.throws(() => parseStoredScriptOutput(paid.result, schema), (e: unknown) => e instanceof ScriptOutputError && e.reason === c.reason);
    assert.equal([...store.ops.values()][0].status, "COMMITTED");
    assert.equal([...store.ops.values()][0].committedUsd, .012);
    const saved = JSON.parse([...results.objects.values()][0].toString());
    assert.equal(saved.stop_reason, c.stop);
    assert.equal(saved.usage.output_tokens, 2000);
    assert.equal(saved.content[0].text, c.text);
    const replay = await guardScriptLedgerCall({ store, results }, scope, params, .047, () => .012, () => client.messages.create(params));
    assert.equal(replay.reused, true);
    assert.equal(calls, 1, "replaying the same paid operation must never call the provider again");
  }
});

test("SDK parse failure is reproduced and classified without leaking its private response", async () => {
  const client = new Anthropic({ apiKey: "fixture", maxRetries: 0, fetch: async () => new Response(JSON.stringify({
    id: "msg_fixture", type: "message", role: "assistant", model: "fixture", stop_reason: "max_tokens",
    content: [{ type: "text", text: '{"title":"PRIVATE_PAYLOAD' }], usage: { input_tokens: 1, output_tokens: 2000 },
  }), { headers: { "content-type": "application/json" } }) });
  const params = { model: "fixture", max_tokens: 2000, messages: [{ role: "user" as const, content: "fixture" }], output_config: { format: zodOutputFormat(z.object({ title: z.string() })) } };
  await assert.rejects(client.messages.parse(params), (e: unknown) => {
    assert.equal(scriptErrorCode(e), "anthropic_structured_output_error");
    assert.ok(!classifyScriptError(e).includes("PRIVATE_PAYLOAD"));
    return true;
  });
});

test("all corrections share a decreasing deadline; no new reservation after the budget expires", () => {
  let time = 0;
  const budget = scriptCallBudget(() => time);
  budget.beforeCall();
  assert.deepEqual(budget.options(), { maxRetries: 0, timeout: 40_000 });
  time = 25_000;
  budget.beforeCall();
  assert.equal(budget.options().timeout, 15_000);
  time = 36_000;
  assert.throws(() => budget.beforeCall(), (e: unknown) => e instanceof ScriptOutputError && e.reason === "deadline_exceeded");
});
