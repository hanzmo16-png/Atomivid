import { test } from "node:test";
import assert from "node:assert/strict";
import { checkImageBudget, checkPremiumVideoBudget, estimateStoryboardCost } from "./cost-estimator";
import { simulateStoryboard } from "./storyboard/simulate";
import type { GeneratedScript } from "@/lib/providers/types";
import type { StoryboardScene } from "./storyboard/types";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = Object.keys(vars);
  const originals = keys.map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeScene(overrides: Partial<StoryboardScene> = {}): StoryboardScene {
  const script: GeneratedScript = {
    title: "t",
    segments: [{ text: "hola", visualQuery: "person" }],
  };
  return { ...simulateStoryboard(script).scenes[0], ...overrides };
}

test("checkImageBudget permite generar cuando queda presupuesto", () => {
  withEnv({ MAX_VISUAL_COST_USD: "1" }, () => {
    const decision = checkImageBudget(makeScene({ maxCostUsd: 0.05 }), 0);
    assert.equal(decision.allowed, true);
  });
});

test("checkImageBudget rechaza cuando excedería el máximo total", () => {
  withEnv({ MAX_VISUAL_COST_USD: "0.1" }, () => {
    const decision = checkImageBudget(makeScene({ maxCostUsd: 0.05 }), 0.08);
    assert.equal(decision.allowed, false);
  });
});

test("checkPremiumVideoBudget rechaza si PREMIUM_CLIPS_ENABLED está apagado, aunque haya presupuesto", () => {
  withEnv({ PREMIUM_CLIPS_ENABLED: "false", MAX_PREMIUM_VIDEO_COST_USD: "10" }, () => {
    const decision = checkPremiumVideoBudget(0, 0, 0.25);
    assert.equal(decision.allowed, false);
  });
});

test("checkPremiumVideoBudget rechaza al alcanzar MAX_PREMIUM_CLIPS aunque haya presupuesto", () => {
  withEnv({ PREMIUM_CLIPS_ENABLED: "true", MAX_PREMIUM_CLIPS: "1", MAX_PREMIUM_VIDEO_COST_USD: "10" }, () => {
    const decision = checkPremiumVideoBudget(1, 0, 0.25);
    assert.equal(decision.allowed, false);
  });
});

test("checkPremiumVideoBudget permite el primer clip cuando todo está habilitado y hay presupuesto", () => {
  withEnv({ PREMIUM_CLIPS_ENABLED: "true", MAX_PREMIUM_CLIPS: "1", MAX_PREMIUM_VIDEO_COST_USD: "1" }, () => {
    const decision = checkPremiumVideoBudget(0, 0, 0.25);
    assert.equal(decision.allowed, true);
  });
});

test("estimateStoryboardCost nunca excede los límites configurados, sin importar cuántas escenas recomienden generación", () => {
  withEnv(
    { MAX_VISUAL_COST_USD: "0.5", PREMIUM_CLIPS_ENABLED: "true", MAX_PREMIUM_CLIPS: "1", MAX_PREMIUM_VIDEO_COST_USD: "1" },
    () => {
      const scenes = Array.from({ length: 10 }, () => makeScene({ resourceType: "generated_image" }));
      const estimate = estimateStoryboardCost(scenes, 0.2, 0.05);
      assert.ok(estimate.estimatedImageCostUsd <= 0.5);
      assert.ok(estimate.estimatedTotalUsd <= 0.5 + 1 + estimate.estimatedMusicCostUsd);
    },
  );
});

test("estimateStoryboardCost da costo musical 0 salvo que MUSIC_PROVIDER=beatoven", () => {
  withEnv({ MUSIC_PROVIDER: undefined }, () => {
    const estimate = estimateStoryboardCost([], 0.2, 0.05);
    assert.equal(estimate.estimatedMusicCostUsd, 0);
  });
});
