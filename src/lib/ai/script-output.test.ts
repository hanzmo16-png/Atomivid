import test from "node:test";
import assert from "node:assert/strict";
import { ScriptOutputError, requireScriptOutput } from "../video/script-output";
import { classifyScriptError, scriptErrorCode } from "../video/script-error";
import { isNoRetryScriptMessage } from "../video/script-retry";

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
  const responses = [script(73), script(83), script(83).segments[0], null];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const output = responses.shift();
    return new Response(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: body.model,
      content: output ? [{ type: "text", text: JSON.stringify(output) }] : [],
      stop_reason: output ? "end_turn" : "max_tokens", stop_sequence: null,
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
