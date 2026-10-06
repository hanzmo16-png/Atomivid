import test from "node:test";
import assert from "node:assert/strict";
import { scriptConfigSummary } from "./script-config";

test("documentary model overrides the general model without changing short form", () => {
  const result = scriptConfigSummary({ ANTHROPIC_SCRIPT_MODEL: "claude-sonnet-5", ANTHROPIC_LONG_FORM_SCRIPT_MODEL: "claude-opus-4-6", PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS: "5" });
  assert.equal(result.longModel, "claude-opus-4-6");
  assert.equal(result.shortModel, "claude-sonnet-5");
  assert.equal(result.input.usd, 5);
  assert.equal(result.output.source, "Valor predeterminado");
});

test("summary excludes credentials and redacts unexpected model values", () => {
  const secret = "sk-ant-private-example";
  const serialized = JSON.stringify(scriptConfigSummary({ ANTHROPIC_API_KEY: secret, ANTHROPIC_SCRIPT_MODEL: secret, PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS: secret }));
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("ANTHROPIC_API_KEY"));
  assert.match(serialized, /Configuración no reconocida/);
});
