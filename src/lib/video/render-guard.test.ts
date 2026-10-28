import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRenderStart, isExhaustedStaleAttempt, MAX_ZERO_SPEND_RESTARTS, zeroSpendRestartCandidate, type RenderStartRow } from "./render-guard";
import { LONG_FORM_HEARTBEAT_STALE_MS, MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "./limits";

const NOW = new Date("2026-09-16T20:00:00.000Z").getTime();

function row(overrides: Partial<RenderStartRow>): RenderStartRow {
  return {
    status: "script_ready",
    render_attempts: 0,
    render_started_at: null,
    ...overrides,
  };
}

test("permite iniciar el render cuando el guion está listo", () => {
  assert.deepEqual(evaluateRenderStart(row({ status: "script_ready" }), NOW), { allowed: true });
});

test("permite reintentar cuando el estado anterior es failed", () => {
  assert.deepEqual(evaluateRenderStart(row({ status: "failed" }), NOW), { allowed: true });
});

test("rechaza (409) una solicitud duplicada mientras sigue en processing", () => {
  const decision = evaluateRenderStart(
    row({
      status: "processing",
      render_started_at: new Date(NOW - 1000).toISOString(),
    }),
    NOW,
  );
  assert.equal(decision.allowed, false);
  if (decision.allowed) throw new Error("unreachable");
  assert.equal(decision.status, 409);
  assert.match(decision.error, /ya se está generando/);
});

test("rechaza (409) un estado que no permite iniciar render (p. ej. completed)", () => {
  const decision = evaluateRenderStart(row({ status: "completed" }), NOW);
  assert.equal(decision.allowed, false);
  if (decision.allowed) throw new Error("unreachable");
  assert.equal(decision.status, 409);
  assert.match(decision.error, /ya está en estado "completed"/);
});

test("trata un processing colgado (más de RENDER_TIMEOUT_MS) como reintentable", () => {
  const startedAt = NOW - RENDER_TIMEOUT_MS - 1;
  const decision = evaluateRenderStart(
    row({ status: "processing", render_started_at: new Date(startedAt).toISOString() }),
    NOW,
  );
  assert.deepEqual(decision, { allowed: true });
});

test("un processing justo en el límite del timeout todavía bloquea", () => {
  const startedAt = NOW - RENDER_TIMEOUT_MS + 1000;
  const decision = evaluateRenderStart(
    row({ status: "processing", render_started_at: new Date(startedAt).toISOString() }),
    NOW,
  );
  assert.equal(decision.allowed, false);
});

test("rechaza (409) al alcanzar el máximo de intentos de render", () => {
  const decision = evaluateRenderStart(
    row({ status: "failed", render_attempts: MAX_RENDER_ATTEMPTS }),
    NOW,
  );
  assert.equal(decision.allowed, false);
  if (decision.allowed) throw new Error("unreachable");
  assert.equal(decision.status, 409);
  assert.match(decision.error, new RegExp(`máximo de ${MAX_RENDER_ATTEMPTS}`));
});

test("permite el intento justo antes de alcanzar el máximo", () => {
  const decision = evaluateRenderStart(
    row({ status: "failed", render_attempts: MAX_RENDER_ATTEMPTS - 1 }),
    NOW,
  );
  assert.deepEqual(decision, { allowed: true });
});

test("legacy processing without a start date can recover from creation date", () => {
  assert.deepEqual(evaluateRenderStart(row({status:"processing",created_at:new Date(NOW-RENDER_TIMEOUT_MS-1).toISOString()}),NOW),{allowed:true});
});
test("invalid timestamps never authorize an automatic overlapping attempt", () => {
  assert.equal(evaluateRenderStart(row({status:"processing",render_started_at:"invalid"}),NOW).allowed,false);
});

test("intento colgado SIN intentos restantes: se reconoce para cerrarlo (antes quedaba en processing para siempre)", () => {
  const started = new Date(NOW - LONG_FORM_HEARTBEAT_STALE_MS - 60_000).toISOString();
  const stuck = row({ status: "processing", mode: "long_form", render_attempts: MAX_RENDER_ATTEMPTS, render_started_at: started, long_form_progress: { updatedAt: started } } as Partial<RenderStartRow>);
  assert.equal(evaluateRenderStart(stuck, NOW).allowed, false, "no se permite un 4.º intento");
  assert.equal(isExhaustedStaleAttempt(stuck, NOW), true, "pero sí se cierra como fallo terminal");
  // Con latido reciente sigue trabajando: no se cierra.
  const alive = { ...stuck, long_form_progress: { updatedAt: new Date(NOW - 60_000).toISOString() } } as RenderStartRow;
  assert.equal(isExhaustedStaleAttempt(alive, NOW), false);
  // Con intentos restantes lo gestiona el reintento normal, no este cierre.
  assert.equal(isExhaustedStaleAttempt({ ...stuck, render_attempts: MAX_RENDER_ATTEMPTS - 1 }, NOW), false);
});

test("Long Form reconfigurado tras paradas de material: candidato a reinicio sin gasto solo confirmado, en script_ready y bajo el tope duro", () => {
  const lf = (o: Partial<RenderStartRow> & { long_form_confirmed_at?: string | null }) =>
    ({ ...row({ mode: "long_form", render_attempts: MAX_RENDER_ATTEMPTS, ...o }), long_form_confirmed_at: "2026-10-28T12:17:49Z", ...o });
  assert.equal(zeroSpendRestartCandidate(lf({})), true);
  assert.equal(zeroSpendRestartCandidate(lf({ render_attempts: MAX_RENDER_ATTEMPTS + MAX_ZERO_SPEND_RESTARTS - 1 })), true);
  assert.equal(zeroSpendRestartCandidate(lf({ render_attempts: MAX_RENDER_ATTEMPTS + MAX_ZERO_SPEND_RESTARTS })), false, "tope duro");
  assert.equal(zeroSpendRestartCandidate(lf({ render_attempts: 1 })), false, "con intentos libres decide evaluateRenderStart");
  assert.equal(zeroSpendRestartCandidate(lf({ long_form_confirmed_at: null })), false);
  assert.equal(zeroSpendRestartCandidate(lf({ status: "failed" })), false);
  assert.equal(zeroSpendRestartCandidate(lf({ mode: "visual" })), false);
  // La decisión pura no cambia: la excepción vive en la ruta, detrás de la prueba del ledger.
  assert.equal(evaluateRenderStart(lf({}), NOW).allowed, false);
});
