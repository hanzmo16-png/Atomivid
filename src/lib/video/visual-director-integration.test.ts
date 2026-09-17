import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estructural: confirma que la llamada al storyboard en
 * generate-video.ts está detrás del feature flag Y envuelta en try/catch
 * (una integración opcional desactivada, o que falla, nunca debe afectar
 * el render) — ver el comentario "0. Storyboard semántico" en ese archivo.
 */
test("la llamada al Visual Director en generate-video.ts está detrás del flag y nunca puede tumbar el render", () => {
  const source = readFileSync(
    path.join(__dirname, "generate-video.ts"),
    "utf8",
  );

  const flagIndex = source.indexOf("getFeatureFlags().visualDirectorEnabled");
  assert.ok(flagIndex > -1, "generate-video.ts debería consultar el flag visualDirectorEnabled");

  const buildCallIndex = source.indexOf("await buildStoryboard(");
  assert.ok(buildCallIndex > -1, "generate-video.ts debería llamar a buildStoryboard()");
  assert.ok(buildCallIndex > flagIndex, "buildStoryboard() debería llamarse DESPUÉS de consultar el flag, no antes");

  const tryIndex = source.lastIndexOf("try {", buildCallIndex);
  const catchIndex = source.indexOf("} catch (err) {", buildCallIndex);
  assert.ok(tryIndex > -1 && tryIndex < buildCallIndex, "buildStoryboard() debería estar dentro de un try");
  assert.ok(catchIndex > buildCallIndex, "buildStoryboard() debería tener un catch después");
});
