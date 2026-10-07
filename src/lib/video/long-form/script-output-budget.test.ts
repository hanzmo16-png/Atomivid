import { test } from "node:test";
import assert from "node:assert/strict";
import { documentaryOutputBudget } from "./script-output-budget";

test("Sonnet 5 reserves a bounded combined reasoning/JSON budget", () => {
  assert.deepEqual(documentaryOutputBudget("claude-sonnet-5"), { max_tokens: 16_000, effort: "medium" });
});
test("unverified model overrides do not inherit Sonnet-specific request options", () => {
  for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5", "unknown"])
    assert.deepEqual(documentaryOutputBudget(model), { max_tokens: 8_000 });
});
