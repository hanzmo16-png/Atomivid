import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScriptQuality, ScriptQualityError } from "./script-quality";

const TOPIC = "los resultados tienen un precio disciplina constancia y sacrificio";

function goodScript() {
  return {
    segments: [
      { text: "Empiezas sin saber si vale la pena el esfuerzo.", visualQuery: "person running early morning" },
      { text: "Cada día que sigues, algo dentro se fortalece.", visualQuery: "tired athlete stretching" },
      { text: "Nadie ve el trabajo que nadie aplaude.", visualQuery: "empty gym at night" },
      { text: "Y entonces, un día, todo cambia de golpe.", visualQuery: "sunrise over mountain trail" },
    ],
  };
}

test("checkScriptQuality rechaza el proveedor de respaldo (fixture) aunque el texto sea válido", () => {
  const result = checkScriptQuality(goodScript(), {
    topic: TOPIC,
    targetWords: 32,
    providerName: "fixture",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue, "fallback_provider");
});

test("checkScriptQuality acepta un guion real con proveedor anthropic, variado y sin repetición", () => {
  const result = checkScriptQuality(goodScript(), {
    topic: TOPIC,
    targetWords: 32,
    providerName: "anthropic",
  });
  assert.deepEqual(result, { ok: true });
});

test("checkScriptQuality: regresión exacta — repetición literal de la misma frase (firma del fixture)", () => {
  // Reproduce el caso real reportado: el fixture rellena una escena
  // repitiendo su propia plantilla cuando el tema es corto.
  const script = {
    segments: [
      {
        text: `Hoy hablamos de ${TOPIC}. Hoy hablamos de ${TOPIC}.`,
        visualQuery: `${TOPIC} motivation 1`,
      },
      { text: `Esto es lo que nadie te cuenta sobre ${TOPIC}.`, visualQuery: `${TOPIC} motivation 2` },
    ],
  };
  const result = checkScriptQuality(script, { topic: TOPIC, targetWords: 32, providerName: "anthropic" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue, "excessive_repetition");
});

test("checkScriptQuality: regresión — visual queries duplicadas entre escenas", () => {
  const script = {
    segments: [
      { text: "Primera escena distinta.", visualQuery: "person walking city street" },
      { text: "Segunda escena también distinta.", visualQuery: "person walking city street" },
    ],
  };
  const result = checkScriptQuality(script, { topic: TOPIC, targetWords: 20, providerName: "anthropic" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue, "duplicate_visual_queries");
});

test("checkScriptQuality: regresión — visual query es el tema completo en vez de una consulta concreta", () => {
  const script = {
    segments: [
      { text: "Primera escena distinta.", visualQuery: TOPIC },
      { text: "Segunda escena distinta también.", visualQuery: "close up hands writing notebook" },
    ],
  };
  const result = checkScriptQuality(script, { topic: TOPIC, targetWords: 20, providerName: "anthropic" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue, "generic_visual_query");
});

test("checkScriptQuality rechaza un guion con muy pocas palabras respecto al objetivo", () => {
  const script = { segments: [{ text: "Muy corto.", visualQuery: "short clip" }] };
  const result = checkScriptQuality(script, { topic: TOPIC, targetWords: 80, providerName: "anthropic" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue, "word_count_out_of_range");
});

test("ScriptQualityError conserva el resultado de calidad para clasificar el error después", () => {
  const err = new ScriptQualityError({
    ok: false,
    issue: "fallback_provider",
    detail: "detalle de prueba",
  });
  assert.ok(err instanceof Error);
  assert.equal(err.result.issue, "fallback_provider");
});
