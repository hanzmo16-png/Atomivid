import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "./anthropic-error";
const grammar = "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";
const error = (status: number, message: string, type = "invalid_request_error") => Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());

test("only explicit Anthropic 400 compiler rejection is classified as final", () => {
  assert.deepEqual(classifyAnthropicError(error(400, grammar)), { kind: "rejected_final" });
  for (const e of [error(400, "Other invalid request"), error(500, grammar), error(429, grammar), error(400, grammar, "api_error"), new Error(grammar), new Error("timeout")])
    assert.deepEqual(classifyAnthropicError(e), { kind: "uncertain" });
});
