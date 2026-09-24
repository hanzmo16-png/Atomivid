import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAiVideoCostConfig,
  assertAiVideoBudget,
  emptyAiVideoLedgerState,
  recordAiVideoSpend,
  AI_VIDEO_COST_PRESETS,
} from "./ai-video-cost-guard";

const ENV_KEYS = [
  "LONG_FORM_AI_VIDEO_ENABLED",
  "LONG_FORM_AI_VIDEO_COST_PRESET",
  "AI_VIDEO_BUDGET_PERCENT",
  "MAX_AI_VIDEO_SECONDS",
  "MAX_AI_VIDEO_CLIPS",
  "MAX_ESTIMATED_VIDEO_COST_USD",
  "AI_VIDEO_COST_PER_SECOND_USD",
  "AI_IMAGE_MOTION_COST_PER_SECOND_USD",
];

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const originals = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("los 3 presets existen y tienen límites crecientes (economic < balanced < premium)", () => {
  assert.deepEqual([...AI_VIDEO_COST_PRESETS], ["economic", "balanced", "premium"]);
  const economic = getAiVideoCostConfig("economic");
  const balanced = getAiVideoCostConfig("balanced");
  const premium = getAiVideoCostConfig("premium");
  assert.ok(economic.maxEstimatedCostUsd < balanced.maxEstimatedCostUsd);
  assert.ok(balanced.maxEstimatedCostUsd < premium.maxEstimatedCostUsd);
  assert.ok(economic.maxSeconds < balanced.maxSeconds);
  assert.ok(balanced.maxSeconds < premium.maxSeconds);
});

test("sin preset explícito, usa LONG_FORM_AI_VIDEO_COST_PRESET del feature flag (default 'balanced')", async () => {
  await withEnv({}, () => {
    assert.equal(getAiVideoCostConfig().preset, "balanced");
  });
  await withEnv({ LONG_FORM_AI_VIDEO_COST_PRESET: "premium" }, () => {
    assert.equal(getAiVideoCostConfig().preset, "premium");
  });
  await withEnv({ LONG_FORM_AI_VIDEO_COST_PRESET: "not-a-real-preset" }, () => {
    assert.equal(getAiVideoCostConfig().preset, "balanced");
  });
});

test("una env var individual sobreescribe SOLO ese número del preset, el resto queda igual", async () => {
  const baselineMaxSeconds = await withEnv({}, () => getAiVideoCostConfig("balanced").maxSeconds);
  await withEnv({ MAX_AI_VIDEO_CLIPS: "99" }, () => {
    const config = getAiVideoCostConfig("balanced");
    assert.equal(config.maxClips, 99);
    assert.equal(config.maxSeconds, baselineMaxSeconds); // sin la env var de segundos, sigue siendo el default del preset
  });
});

test("LONG_FORM_AI_VIDEO_ENABLED=false (default) rechaza cualquier gasto, sin importar el resto de límites", async () => {
  await withEnv({}, () => {
    const config = getAiVideoCostConfig("premium"); // límites generosos
    const decision = assertAiVideoBudget(emptyAiVideoLedgerState(), 1, 0.01, 1000, config);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /LONG_FORM_AI_VIDEO_ENABLED=false/);
  });
});

test("dentro de todos los límites y con el flag encendido, se permite", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, () => {
    const config = getAiVideoCostConfig("balanced");
    const decision = assertAiVideoBudget(emptyAiVideoLedgerState(), 5, 0.25, 1000, config);
    assert.equal(decision.allowed, true);
  });
});

test("rechaza si excede AI_VIDEO_BUDGET_PERCENT de la duración total del documental", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true", AI_VIDEO_BUDGET_PERCENT: "10" }, () => {
    const config = getAiVideoCostConfig("balanced");
    // 15s de 100s totales = 15%, por encima del 10% configurado.
    const decision = assertAiVideoBudget(emptyAiVideoLedgerState(), 15, 0.5, 100, config);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /AI_VIDEO_BUDGET_PERCENT/);
  });
});

test("rechaza si excede MAX_AI_VIDEO_SECONDS aunque el % esté dentro de rango", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true", AI_VIDEO_BUDGET_PERCENT: "100", MAX_AI_VIDEO_SECONDS: "10" }, () => {
    const config = getAiVideoCostConfig("balanced");
    const decision = assertAiVideoBudget(emptyAiVideoLedgerState(), 15, 0.5, 1000, config);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /MAX_AI_VIDEO_SECONDS/);
  });
});

test("rechaza si excede MAX_AI_VIDEO_CLIPS", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true", MAX_AI_VIDEO_CLIPS: "1" }, () => {
    const config = getAiVideoCostConfig("balanced");
    const ledgerWithOneClip = recordAiVideoSpend(emptyAiVideoLedgerState(), 5, 0.25);
    const decision = assertAiVideoBudget(ledgerWithOneClip, 5, 0.25, 1000, config);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /MAX_AI_VIDEO_CLIPS/);
  });
});

test("rechaza si excede MAX_ESTIMATED_VIDEO_COST_USD", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true", MAX_ESTIMATED_VIDEO_COST_USD: "0.1" }, () => {
    const config = getAiVideoCostConfig("balanced");
    const decision = assertAiVideoBudget(emptyAiVideoLedgerState(), 5, 0.25, 1000, config);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /MAX_ESTIMATED_VIDEO_COST_USD/);
  });
});

test("totalDocumentaryDurationSec=0 nunca dispara el chequeo de % (evita división por cero / falso rechazo)", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, () => {
    const config = getAiVideoCostConfig("balanced");
    const decision = assertAiVideoBudget(emptyAiVideoLedgerState(), 5, 0.25, 0, config);
    assert.equal(decision.allowed, true);
  });
});

test("recordAiVideoSpend acumula segundos/clips/USD de forma pura, sin mutar el ledger original", () => {
  const initial = emptyAiVideoLedgerState();
  const updated = recordAiVideoSpend(initial, 5, 0.25);
  assert.deepEqual(initial, { usedSeconds: 0, usedClips: 0, spentUsd: 0 });
  assert.deepEqual(updated, { usedSeconds: 5, usedClips: 1, spentUsd: 0.25 });
});
