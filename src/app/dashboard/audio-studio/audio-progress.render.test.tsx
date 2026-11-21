import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioGenerationProgress } from "./AudioGenerationProgress";
import { IDLE_GENERATION, STALE_MS, type Generation } from "@/lib/audio-studio/model";
const now = Date.now();
const active: Generation = { ...IDLE_GENERATION, status: "generando", heartbeatAt: new Date(now).toISOString() };
const html = (g: Generation, props = {}) => renderToStaticMarkup(<AudioGenerationProgress generation={g} now={now} {...props} />);
test("first click shows immediate indeterminate acknowledgement, even after an old result", () => {
  for (const status of ["inactiva", "terminada"] as const) {
    const s = html({ ...IDLE_GENERATION, status }, { submitting: true });
    assert.match(s, /Enviando solicitud/); assert.match(s, /role="progressbar"/); assert.doesNotMatch(s, /aria-valuenow|Podcast listo/);
  }
});
test("queue with null progress remains visible without invented percentage", () => {
  const s = html({ ...active, status: "en_cola" });
  assert.match(s, /Solicitud recibida/); assert.match(s, /role="progressbar"/); assert.doesNotMatch(s, /aria-valuenow/);
});
test("voice percentage is measured and 100% of voices is not a finished podcast", () => {
  const partial = html({ ...active, progress: { done: 7, total: 20 } });
  assert.match(partial, /Generando voces · 35%/); assert.match(partial, /aria-valuenow="35"/);
  const mix = html({ ...active, progress: { done: 20, total: 20 } });
  assert.match(mix, /mezclando y preparando/); assert.doesNotMatch(mix, /Podcast listo|aria-valuenow="100"/);
});
test("terminal result, failure and stale queue are explicit", () => {
  assert.match(html({ ...active, status: "terminada" }), /Podcast listo · 100%/);
  assert.match(html({ ...active, status: "fallida" }), /No se pudo completar/);
  assert.match(html({ ...active, status: "en_cola", heartbeatAt: new Date(now - STALE_MS - 1).toISOString() }), /dejó de informar avances/);
});
test("lost connection overrides apparent progress and avoids retry advice", () => {
  const s = html({ ...active, progress: { done: 7, total: 20 } }, { connectionError: true });
  assert.match(s, /Comprobando el estado/); assert.match(s, /no vuelvas a generar/); assert.doesNotMatch(s, /aria-valuenow/);
  assert.match(html(IDLE_GENERATION, { uncertain: true }), /Comprobando el estado/);
});
