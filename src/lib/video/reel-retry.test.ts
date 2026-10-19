import { test } from "node:test";
import assert from "node:assert/strict";
import { canReviewReelRetry } from "./reel-retry";

const NOW = Date.parse("2026-10-19T19:00:00Z");
const base = {
  mode: "visual",
  status: "failed",
  render_attempts: 1,
  render_started_at: "2026-10-19T18:00:00Z",
  created_at: "2026-10-19T17:00:00Z",
  script_json: { title: "Reel", segments: [{ text: "Texto", visualQuery: "escena" }] },
  error_message: "Falló el render",
};

test("reel fallido con guion preparado puede volver a revisión; no despacha por sí solo", () => {
  assert.equal(canReviewReelRetry(base, NOW), true);
});
test("no se abre reintento para error de soporte ni intentos agotados", () => {
  assert.equal(canReviewReelRetry({ ...base, error_message: "HTTP 401 credential refused" }, NOW), false);
  assert.equal(canReviewReelRetry({ ...base, render_attempts: 3 }, NOW), false);
});
test("no se reintenta un guion propio todavía sin preparar ni una solicitud sin guion", () => {
  const draft = { source: "own" as const, visualsPlanned: false as const, ownText: "Hola", title: "X", segments: [{ text: "Hola", visualQuery: "" }] };
  assert.equal(canReviewReelRetry({ ...base, script_json: draft }, NOW), false);
  assert.equal(canReviewReelRetry({ ...base, script_json: null }, NOW), false);
});
test("solo Reel: nunca habilita avatar, documental, pendiente ni completado", () => {
  for (const mode of ["avatar", "long_form", "podcast"]) assert.equal(canReviewReelRetry({ ...base, mode }, NOW), false);
  for (const status of ["pending", "script_ready", "completed"]) assert.equal(canReviewReelRetry({ ...base, status }, NOW), false);
});
test("un render activo no se puede reintentar; uno vencido sí, salvo espera de capacidad", () => {
  const running = { ...base, status: "processing", render_started_at: "2026-10-19T18:59:00Z" };
  assert.equal(canReviewReelRetry(running, NOW), false);
  assert.equal(canReviewReelRetry({ ...running, render_started_at: "2026-10-19T18:00:00Z" }, NOW), true);
  assert.equal(canReviewReelRetry({ ...running, render_started_at: "2026-10-19T18:00:00Z", supply_wait_started_at: "2026-10-19T18:01:00Z" }, NOW), false);
});
