import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStoryboard, StoryboardSchema } from "./types";
import { simulateStoryboard } from "./simulate";
import type { GeneratedScript } from "@/lib/providers/types";

function makeScript(): GeneratedScript {
  return {
    title: "Test",
    segments: [
      { text: "Escena uno.", visualQuery: "person waking up", visualConcepts: ["person waking up dark"] },
      { text: "Escena dos.", visualQuery: "person running", visualConcepts: ["person running storm"] },
    ],
  };
}

test("un storyboard bien formado valida contra el schema", () => {
  const result = validateStoryboard(simulateStoryboard(makeScript()));
  assert.equal(result.valid, true);
});

test("un storyboard al que le falta un campo obligatorio NO valida", () => {
  const storyboard = simulateStoryboard(makeScript()) as unknown as Record<string, unknown>;
  const scenes = storyboard.scenes as Array<Record<string, unknown>>;
  delete scenes[0].visibleAction;

  const result = validateStoryboard(storyboard);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("visibleAction")));
  }
});

test("una escena con fallbackStrategy vacío NO valida (nunca sin red de seguridad)", () => {
  const storyboard = simulateStoryboard(makeScript()) as unknown as Record<string, unknown>;
  const scenes = storyboard.scenes as Array<Record<string, unknown>>;
  scenes[0].fallbackStrategy = [];

  const result = validateStoryboard(storyboard);
  assert.equal(result.valid, false);
});

test("un resourceType fuera del enum permitido NO valida", () => {
  const storyboard = simulateStoryboard(makeScript()) as unknown as Record<string, unknown>;
  const scenes = storyboard.scenes as Array<Record<string, unknown>>;
  scenes[0].resourceType = "hand_drawn_illustration";

  const result = validateStoryboard(storyboard);
  assert.equal(result.valid, false);
});

test("el aspectRatio de visualIdentity está fijado a 9:16", () => {
  const shape = StoryboardSchema.shape.visualIdentity.shape.aspectRatio;
  assert.equal(shape.value, "9:16");
});

test("simulateStoryboard produce una escena por cada segmento del guion, en orden", () => {
  const script = makeScript();
  const storyboard = simulateStoryboard(script);
  assert.equal(storyboard.scenes.length, script.segments.length);
  storyboard.scenes.forEach((scene, i) => {
    assert.equal(scene.order, i);
    assert.equal(scene.narrationText, script.segments[i].text);
  });
});

test("simulateStoryboard nunca requiere red ni credenciales (no lanza sin ANTHROPIC_API_KEY)", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.doesNotThrow(() => simulateStoryboard(makeScript()));
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});
