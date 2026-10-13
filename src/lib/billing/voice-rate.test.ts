import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ELEVENLABS_USD_PER_1K_CHARS_DEFAULT, getPricingConfig } from "./pricing";
import { workflowLiteralEnv } from "@/lib/ops/config-parity";

const root = path.join(__dirname, "../../..");

test("voice rate has one source: the shared constant (0.2, the value the worker used), overridable by env", () => {
  assert.equal(ELEVENLABS_USD_PER_1K_CHARS_DEFAULT, 0.2);
  const saved = process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS;
  try {
    delete process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS;
    assert.equal(getPricingConfig().elevenLabsUsdPer1kChars, ELEVENLABS_USD_PER_1K_CHARS_DEFAULT);
    process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS = "0.3";
    assert.equal(getPricingConfig().elevenLabsUsdPer1kChars, 0.3);
  } finally {
    if (saved === undefined) delete process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS; else process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS = saved;
  }
});

test("the render and podcast workers no longer hard-code their own voice rate", () => {
  for (const [file, step] of [[".github/workflows/render.yml", "name: Renderizar video"], [".github/workflows/podcast-video.yml", "env:"]] as const) {
    const yml = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(yml, /PRICING_ELEVENLABS_USD_PER_1K_CHARS\s*:/, `${file} must read the shared constant`);
    assert.ok(!("PRICING_ELEVENLABS_USD_PER_1K_CHARS" in workflowLiteralEnv(yml, step).literals));
  }
});

test("no other app or script code keeps its own voice-rate fallback", () => {
  const voiceComparison = readFileSync(path.join(root, "scripts/voice-comparison.ts"), "utf8");
  assert.doesNotMatch(voiceComparison, /PRICING_ELEVENLABS_USD_PER_1K_CHARS\s*\|\|/);
  const pricing = readFileSync(path.join(root, "src/lib/billing/pricing.ts"), "utf8");
  assert.match(pricing, /rate\("PRICING_ELEVENLABS_USD_PER_1K_CHARS", ELEVENLABS_USD_PER_1K_CHARS_DEFAULT\)/);
  assert.match(pricing, /TODO: confirmar con el plan real de ElevenLabs \(Hans\)/);
});
