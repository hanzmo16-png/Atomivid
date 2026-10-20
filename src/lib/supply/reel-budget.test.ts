import test from "node:test";
import assert from "node:assert/strict";
import { reelProviderSpendCap, ReelBudgetExceededError } from "./reel-budget";
import { classifyScriptError, scriptErrorCode } from "@/lib/video/script-error";

test("new Reel defaults to USD 1.50 and invalid operator values fail closed", () => {
  assert.equal(reelProviderSpendCap({}), 1.5);
  assert.equal(reelProviderSpendCap({ REEL_MAX_PROVIDER_SPEND_USD: "0.0001" }), .0001);
  for (const raw of ["", "0", "-1", "NaN", "Infinity", " 1.5", "1e1", "1.50001", "25.0001", "100"])
    assert.throws(() => reelProviderSpendCap({ REEL_MAX_PROVIDER_SPEND_USD: raw }));
});

test("script budget rejection is explicit and never recommends another paid attempt", () => {
  const error = new ReelBudgetExceededError("reel budget exceeded", 1.5);
  assert.equal(scriptErrorCode(error), "reel_budget_exceeded");
  const message = classifyScriptError(error, "abcdef12");
  assert.match(message, /USD 1\.50/);
  assert.match(message, /gastos anteriores se conservan/);
  assert.doesNotMatch(message, /Intenta de nuevo|Pulsa reintentar/);
});
