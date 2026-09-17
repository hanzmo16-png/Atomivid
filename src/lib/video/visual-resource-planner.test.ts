import { test } from "node:test";
import assert from "node:assert/strict";
import { decideResourceStrategy, buildScenePlanEntry, generatedImageObjectPrefix, MIN_GENERATION_CONFIDENCE } from "./visual-resource-planner";
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

function buildScene(overrides: Partial<StoryboardScene> = {}): StoryboardScene {
  return {
    id: "scene-0",
    order: 0,
    narrationText: "La disciplina te lleva más lejos que la motivación.",
    estimatedDurationSeconds: 3.5,
    literalMeaning: "x",
    emotionalSubtext: "x",
    narrativeGoal: "x",
    dominantEmotion: "x",
    energy: "low",
    subject: "a person",
    visibleAction: "a person doing something",
    environment: "bedroom",
    timeOfDay: "dawn",
    shotType: "medium shot",
    cameraMovement: "static",
    lighting: "soft",
    colorPalette: "cool blues",
    visualStyle: "cinematic",
    imagePrompt: "a cinematic photo",
    negativePrompt: "text, watermark",
    stockQueries: ["a", "b"],
    resourceType: "generated_image",
    priority: 1,
    confidence: 0.8,
    selectionRationale: "x",
    continuityWithPrevious: "none",
    continuityWithNext: "none",
    maxCostUsd: 0.1,
    fallbackStrategy: ["retry_prompt", "validated_stock", "motion_graphic"],
    ...overrides,
  };
}

const ALL_FLAGS_ON = { VISUAL_DIRECTOR_ENABLED: "true", OPENAI_IMAGE_GENERATION_ENABLED: "true" };

test("decideResourceStrategy rechaza generación si VISUAL_DIRECTOR_ENABLED está apagado (default)", () => {
  withEnv({ VISUAL_DIRECTOR_ENABLED: undefined, OPENAI_IMAGE_GENERATION_ENABLED: "true" }, () => {
    const decision = decideResourceStrategy(buildScene(), 0, 0);
    assert.equal(decision.useGeneration, false);
  });
});

test("decideResourceStrategy rechaza generación si OPENAI_IMAGE_GENERATION_ENABLED está apagado (default) aunque el Visual Director esté encendido", () => {
  withEnv({ VISUAL_DIRECTOR_ENABLED: "true", OPENAI_IMAGE_GENERATION_ENABLED: undefined }, () => {
    const decision = decideResourceStrategy(buildScene(), 0, 0);
    assert.equal(decision.useGeneration, false);
  });
});

test("decideResourceStrategy rechaza si no hay escena de storyboard para el beat", () => {
  withEnv(ALL_FLAGS_ON, () => {
    const decision = decideResourceStrategy(undefined, 0, 0);
    assert.equal(decision.useGeneration, false);
  });
});

test("decideResourceStrategy rechaza resourceType no elegible (stock_video/generated_video/motion_graphic)", () => {
  withEnv(ALL_FLAGS_ON, () => {
    for (const resourceType of ["stock_video", "generated_video", "motion_graphic"] as const) {
      const decision = decideResourceStrategy(buildScene({ resourceType }), 0, 0);
      assert.equal(decision.useGeneration, false, `resourceType "${resourceType}" no debería ser elegible`);
    }
  });
});

test("decideResourceStrategy acepta resourceType generated_image o abstract con confianza suficiente", () => {
  withEnv(ALL_FLAGS_ON, () => {
    for (const resourceType of ["generated_image", "abstract"] as const) {
      const decision = decideResourceStrategy(buildScene({ resourceType }), 0, 0);
      assert.equal(decision.useGeneration, true, `resourceType "${resourceType}" debería ser elegible`);
    }
  });
});

test("decideResourceStrategy rechaza si la confianza está por debajo del mínimo", () => {
  withEnv(ALL_FLAGS_ON, () => {
    const decision = decideResourceStrategy(buildScene({ confidence: MIN_GENERATION_CONFIDENCE - 0.01 }), 0, 0);
    assert.equal(decision.useGeneration, false);
  });
});

test("decideResourceStrategy acepta exactamente en el mínimo de confianza", () => {
  withEnv(ALL_FLAGS_ON, () => {
    const decision = decideResourceStrategy(buildScene({ confidence: MIN_GENERATION_CONFIDENCE }), 0, 0);
    assert.equal(decision.useGeneration, true);
  });
});

test("decideResourceStrategy rechaza al alcanzar MAX_GENERATED_IMAGES_PER_VIDEO", () => {
  withEnv({ ...ALL_FLAGS_ON, MAX_GENERATED_IMAGES_PER_VIDEO: "2" }, () => {
    assert.equal(decideResourceStrategy(buildScene(), 2, 0).useGeneration, false);
    assert.equal(decideResourceStrategy(buildScene(), 1, 0).useGeneration, true);
  });
});

test("decideResourceStrategy rechaza si excedería MAX_VISUAL_COST_USD", () => {
  withEnv({ ...ALL_FLAGS_ON, MAX_VISUAL_COST_USD: "0.05" }, () => {
    const decision = decideResourceStrategy(buildScene({ maxCostUsd: 0.1 }), 0, 0);
    assert.equal(decision.useGeneration, false);
  });
});

test("decideResourceStrategy nunca sugiere otro proveedor de pago como sustituto — el resultado siempre es stock o generación, nada más", () => {
  withEnv(ALL_FLAGS_ON, () => {
    const decision = decideResourceStrategy(buildScene({ resourceType: "stock_video" }), 0, 0);
    assert.equal(decision.useGeneration, false);
    assert.match(decision.reason, /se usa stock/);
  });
});

test("buildScenePlanEntry refleja la decisión de generación con el prompt real", () => {
  withEnv(ALL_FLAGS_ON, () => {
    const decision = decideResourceStrategy(buildScene(), 0, 0);
    const entry = buildScenePlanEntry(2, 0, 3.5, "narración", "fallback query", decision);
    assert.equal(entry.status, "planned_generated");
    assert.equal(entry.resourceType, "generated_image");
    assert.equal(entry.queryOrPrompt, "a cinematic photo");
    assert.equal(entry.aspectRatio, "9:16");
    assert.equal(entry.sceneId, "scene-2-0");
  });
});

test("buildScenePlanEntry refleja la decisión de stock con la consulta de respaldo", () => {
  withEnv({}, () => {
    const decision = decideResourceStrategy(buildScene(), 0, 0);
    const entry = buildScenePlanEntry(1, 0, 3.5, "narración", "fallback query", decision);
    assert.equal(entry.status, "planned_stock");
    assert.equal(entry.resourceType, "stock");
    assert.equal(entry.queryOrPrompt, "fallback query");
    assert.equal(entry.estimatedCostUsd, 0);
  });
});

test("generatedImageObjectPrefix es determinístico por escena (base de la idempotencia)", () => {
  assert.equal(generatedImageObjectPrefix(3), "scene-3-generated");
  assert.equal(generatedImageObjectPrefix(3), generatedImageObjectPrefix(3));
  assert.notEqual(generatedImageObjectPrefix(3), generatedImageObjectPrefix(4));
});
