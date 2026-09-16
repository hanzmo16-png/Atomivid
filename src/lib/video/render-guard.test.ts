import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRenderStart, type RenderStartRow } from "./render-guard";
import { MAX_RENDER_ATTEMPTS, RENDER_TIMEOUT_MS } from "./limits";

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
