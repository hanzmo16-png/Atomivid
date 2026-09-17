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

/**
 * Prueba estructural: confirma que la llamada a resolveGeneratedImageForScene()
 * (imagen generada) está envuelta en try/catch Y que, tanto si tiene éxito
 * como si falla, el código SIEMPRE puede llegar a selectFootageForScene()
 * (stock) después — nunca hay un camino que reemplace stock por otro
 * proveedor de pago distinto si la generación falla.
 */
test("la llamada a resolveGeneratedImageForScene() en generate-video.ts está en un try/catch y el flujo siempre puede caer a stock", () => {
  const source = readFileSync(path.join(__dirname, "generate-video.ts"), "utf8");

  const resolveCallIndex = source.indexOf("await resolveGeneratedImageForScene(");
  assert.ok(resolveCallIndex > -1, "generate-video.ts debería llamar a resolveGeneratedImageForScene()");

  const tryIndex = source.lastIndexOf("try {", resolveCallIndex);
  const catchIndex = source.indexOf("} catch (err) {", resolveCallIndex);
  assert.ok(tryIndex > -1 && tryIndex < resolveCallIndex, "resolveGeneratedImageForScene() debería estar dentro de un try");
  assert.ok(catchIndex > resolveCallIndex, "resolveGeneratedImageForScene() debería tener un catch después");

  // El catch nunca debe llamar a otro proveedor de pago (Runway/Beatoven/
  // HeyGen) — solo debe registrar el fallo y dejar que el código siga
  // hacia selectFootageForScene() (stock, gratis) más abajo.
  const catchBlockEnd = source.indexOf("\n      } else if (b === 0)", catchIndex);
  const catchBlock = source.slice(catchIndex, catchBlockEnd > -1 ? catchBlockEnd : catchIndex + 600);
  for (const forbidden of ["RunwayProvider", "runwayProvider", "BeatovenProvider", "beatovenProvider", "HeyGen", "heygen"]) {
    assert.ok(!catchBlock.includes(forbidden), `el catch de la generación de imagen nunca debería mencionar "${forbidden}"`);
  }

  const selectFootageIndex = source.indexOf("await selectFootageForScene(");
  assert.ok(selectFootageIndex > catchIndex, "selectFootageForScene() (stock) debería seguir siendo alcanzable después del catch");
});
