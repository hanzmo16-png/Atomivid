import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStyledImagePrompt, checkVisualAvailability, reelLookFor, stockConceptsFor, styledImageObjectPrefix } from "./visuals";
import { evaluateDirectionReadiness } from "./readiness";
import { getFeatureFlags } from "../feature-flags";

const base = { sceneCount: 6, imageGenerationEnabled: true, imageProvider: "openai", estimatedCostPerImageUsd: 0.06, maxVisualCostUsd: 1, maxStyledImages: 10 };

test("la apariencia se propaga a cada escena y la intención cambia la luz, no el dibujo", () => {
  const mystery = buildStyledImagePrompt({ profile: "comic", intent: "suspense", concept: "old lighthouse at night", narration: "Nadie sabe qué pasó." });
  const humor = buildStyledImagePrompt({ profile: "comic", intent: "humor", concept: "cat on keyboard", narration: "Mi gato." });
  for (const p of [mystery, humor]) assert.match(p.prompt, /comic book panel illustration/);
  assert.match(mystery.prompt, /low-key lighting/);
  assert.match(humor.prompt, /bright even lighting/);
  assert.match(mystery.negativePrompt, /photograph/);
  assert.throws(() => buildStyledImagePrompt({ profile: "cinematic_realistic", intent: "humor", concept: "x", narration: "y" }));
});

test("la ruta de la imagen depende del prompt: reintento idéntico reutiliza; guion o estilo nuevos no", () => {
  const a = buildStyledImagePrompt({ profile: "anime", intent: "reflective", concept: "girl at window", narration: "Recuerdo aquel invierno." });
  const same = buildStyledImagePrompt({ profile: "anime", intent: "reflective", concept: "girl at window", narration: "Recuerdo aquel invierno." });
  const edited = buildStyledImagePrompt({ profile: "anime", intent: "reflective", concept: "girl at window", narration: "Recuerdo aquel verano." });
  const restyled = buildStyledImagePrompt({ profile: "illustration_3d", intent: "reflective", concept: "girl at window", narration: "Recuerdo aquel invierno." });
  assert.equal(styledImageObjectPrefix(0, a.key), styledImageObjectPrefix(0, same.key));
  assert.notEqual(a.key, edited.key);
  assert.notEqual(a.key, restyled.key);
  assert.match(styledImageObjectPrefix(2, a.key), /^scene-2-styled-[0-9a-f]{12}$/);
});

test("aceptación 3: sin generación, sin proveedor, con demasiadas escenas o sin presupuesto, se bloquea con motivo y recuperación", () => {
  assert.deepEqual(checkVisualAvailability({ ...base, profile: "cinematic_realistic", imageGenerationEnabled: false }), { ok: true, source: "stock" });
  const cases = [
    [{ imageGenerationEnabled: false }, "generation_disabled"],
    [{ imageProvider: null }, "provider_unavailable"],
    [{ sceneCount: 12 }, "too_many_scenes"],
    [{ maxVisualCostUsd: 0.2 }, "over_budget"],
  ] as const;
  for (const [patch, code] of cases) {
    const r = checkVisualAvailability({ ...base, profile: "anime", ...patch });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, code);
      assert.ok(r.recovery.length > 10);
    }
  }
  const ok = checkVisualAvailability({ ...base, profile: "anime" });
  assert.deepEqual(ok, { ok: true, source: "generated_image", images: 6, estimatedCostUsd: 0.36, maxCostUsd: 1, provider: "openai" });
});

test("readiness combina música e imágenes; «sin música» es válido y un catálogo sin compatibles no", () => {
  const flags = { ...getFeatureFlags(), imageGenerationEnabled: false };
  const r1 = evaluateDirectionReadiness({ profile: "horror_mystery", music: "tension", sceneCount: 6, flags, imageProvider: null, musicProviderSetting: "curated-library" });
  assert.equal(r1.ok, true);
  assert.equal(r1.music.compatibleTracks, 2);
  const r2 = evaluateDirectionReadiness({ profile: "horror_mystery", music: "tension", sceneCount: 6, flags, imageProvider: null, manifest: [], musicProviderSetting: "curated-library" });
  assert.deepEqual(r2.issues.map((i) => i.code), ["no_compatible_track"]);
  const r3 = evaluateDirectionReadiness({ profile: "comic", music: "none", sceneCount: 6, flags, imageProvider: null, manifest: [], musicProviderSetting: "curated-library" });
  assert.deepEqual(r3.issues.map((i) => i.code), ["generation_disabled"]);
});

test("Horror busca primero stock oscuro y oscurece la imagen; Cine realista solo se ajusta si la historia lo pide", () => {
  assert.deepEqual(stockConceptsFor("horror_mystery", ["abandoned house", "empty hallway"]), ["abandoned house dark", "abandoned house", "empty hallway"]);
  assert.deepEqual(stockConceptsFor("cinematic_realistic", ["city"]), ["city"]);
  assert.match(reelLookFor("horror_mystery", "suspense")!.filter, /brightness\(0\.78\)/);
  assert.equal(reelLookFor("cinematic_realistic", "humor"), undefined);
  assert.ok(reelLookFor("cinematic_realistic", "suspense"));
});
