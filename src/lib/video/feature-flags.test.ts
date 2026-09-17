import { test } from "node:test";
import assert from "node:assert/strict";
import { getFeatureFlags } from "./feature-flags";

const FLAG_VARS = [
  "VISUAL_DIRECTOR_ENABLED",
  "IMAGE_PROVIDER",
  "VIDEO_PROVIDER",
  "MUSIC_PROVIDER",
  "PREMIUM_CLIPS_ENABLED",
  "MAX_PREMIUM_CLIPS",
  "MAX_PREMIUM_CLIP_SECONDS",
  "MAX_VISUAL_COST_USD",
  "MAX_PREMIUM_VIDEO_COST_USD",
  "MAX_MUSIC_COST_USD",
  "VISUAL_QA_ENABLED",
  "OPENAI_IMAGE_GENERATION_ENABLED",
  "MAX_GENERATED_IMAGES_PER_VIDEO",
];

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const originals = FLAG_VARS.map((k) => [k, process.env[k]] as const);
  for (const k of FLAG_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
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

test("sin ninguna variable configurada, todas las integraciones nuevas quedan apagadas por defecto", () => {
  withEnv({}, () => {
    const flags = getFeatureFlags();
    assert.equal(flags.visualDirectorEnabled, false);
    assert.equal(flags.imageProvider, "fixture");
    assert.equal(flags.videoProvider, "fixture");
    assert.equal(flags.premiumClipsEnabled, false);
    assert.equal(flags.visualQaEnabled, false);
    assert.equal(flags.imageGenerationEnabled, false);
    assert.equal(flags.maxImagesPerVideo, 3);
  });
});

test("OPENAI_IMAGE_GENERATION_ENABLED acepta '1'/'true'/'yes' como encendido", () => {
  for (const value of ["1", "true", "yes", "TRUE"]) {
    withEnv({ OPENAI_IMAGE_GENERATION_ENABLED: value }, () => {
      assert.equal(getFeatureFlags().imageGenerationEnabled, true, `valor "${value}" debería encender el flag`);
    });
  }
});

test("MAX_GENERATED_IMAGES_PER_VIDEO acepta un entero configurado y rechaza valores inválidos/negativos", () => {
  withEnv({ MAX_GENERATED_IMAGES_PER_VIDEO: "5" }, () => {
    assert.equal(getFeatureFlags().maxImagesPerVideo, 5);
  });
  withEnv({ MAX_GENERATED_IMAGES_PER_VIDEO: "-1" }, () => {
    assert.ok(getFeatureFlags().maxImagesPerVideo >= 0);
  });
});

test("VISUAL_DIRECTOR_ENABLED acepta '1'/'true'/'yes' como encendido", () => {
  for (const value of ["1", "true", "yes", "TRUE"]) {
    withEnv({ VISUAL_DIRECTOR_ENABLED: value }, () => {
      assert.equal(getFeatureFlags().visualDirectorEnabled, true, `valor "${value}" debería encender el flag`);
    });
  }
});

test("un valor no reconocido para un flag booleano cae al default seguro", () => {
  withEnv({ VISUAL_DIRECTOR_ENABLED: "maybe" }, () => {
    assert.equal(getFeatureFlags().visualDirectorEnabled, false);
  });
});

test("los límites numéricos aceptan decimales (costos fraccionarios)", () => {
  withEnv({ MAX_VISUAL_COST_USD: "0.25" }, () => {
    assert.equal(getFeatureFlags().maxVisualCostUsd, 0.25);
  });
});

test("un límite numérico inválido cae al default en vez de NaN", () => {
  withEnv({ MAX_VISUAL_COST_USD: "no-es-un-numero" }, () => {
    assert.equal(Number.isFinite(getFeatureFlags().maxVisualCostUsd), true);
  });
});

test("un límite numérico negativo cae al default (nunca un presupuesto negativo)", () => {
  withEnv({ MAX_PREMIUM_CLIPS: "-5" }, () => {
    assert.ok(getFeatureFlags().maxPremiumClips >= 0);
  });
});
