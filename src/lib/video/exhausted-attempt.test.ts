import { test } from "node:test";
import assert from "node:assert/strict";
import { closeExhaustedStaleAttempt, closeStaleAttempt, closeStaleLongFormAttempt, isStaleLongFormAttempt } from "./exhausted-attempt";
import { decodeStoredFailure } from "./failure-action";
import { LONG_FORM_HEARTBEAT_STALE_MS, MAX_RENDER_ATTEMPTS } from "./limits";
import { EXHAUSTED_ATTEMPT_CLOSED, STALE_LONG_FORM_ATTEMPT_CLOSED } from "./start-outcome";

const NOW = Date.parse("2026-10-22T20:00:00Z");
const started = new Date(NOW - LONG_FORM_HEARTBEAT_STALE_MS - 60_000).toISOString();
const stuck = { id: "r1", status: "processing", mode: "long_form", render_attempts: MAX_RENDER_ATTEMPTS, render_started_at: started, long_form_progress: { updatedAt: started } };

/** Cliente mínimo que registra el UPDATE condicional y responde las filas afectadas. */
function fakeService(affected: number) {
  const calls: { update?: Record<string, unknown>; filters: string[] } = { filters: [] };
  const chain = {
    update(v: Record<string, unknown>) { calls.update = v; return chain; },
    eq(c: string, v: unknown) { calls.filters.push(`${c}=${v}`); return chain; },
    is(c: string, v: unknown) { calls.filters.push(`${c} is ${v}`); return chain; },
    async select() { return { data: Array.from({ length: affected }, () => ({ id: "r1" })), error: null }; },
  };
  const service = { from: () => chain, rpc: async () => ({ data: null, error: null }) };
  return { service: service as never, calls };
}

test("cierra como fallo terminal el intento colgado sin intentos restantes, con compare-and-set sobre el mismo intento", async () => {
  const { service, calls } = fakeService(1);
  assert.equal(await closeExhaustedStaleAttempt(service, stuck, NOW), "closed");
  assert.equal(calls.update?.status, "failed");
  assert.equal(calls.update?.error_message, EXHAUSTED_ATTEMPT_CLOSED);
  assert.deepEqual(calls.filters, ["id=r1", "status=processing", `render_attempts=${MAX_RENDER_ATTEMPTS}`, `render_started_at=${started}`]);
});

test("si el worker volvió a latir o la fila cambió, no se marca nada", async () => {
  const { service } = fakeService(0);
  assert.equal(await closeExhaustedStaleAttempt(service, stuck, NOW), "changed");
  const alive = { ...stuck, long_form_progress: { updatedAt: new Date(NOW - 60_000).toISOString() } };
  const { service: s2, calls } = fakeService(1);
  assert.equal(await closeExhaustedStaleAttempt(s2, alive, NOW), "not_applicable");
  assert.equal(calls.update, undefined, "sin UPDATE para un intento vivo");
  assert.equal(await closeExhaustedStaleAttempt(s2, { ...stuck, render_attempts: 1 }, NOW), "not_applicable", "con intentos restantes decide el reintento normal");
});

// --- END GAME B: Long Form «en cola sin salida» con intentos restantes ---

test("Long Form colgado CON intentos: se cierra como fallo recuperable («Reintentar»), CAS sobre el mismo intento y latido", async () => {
  const row = { ...stuck, render_attempts: 1 };
  const { service, calls } = fakeService(1);
  assert.ok(isStaleLongFormAttempt(row, NOW));
  const result = await closeStaleAttempt(service, row, NOW);
  assert.deepEqual(result, { outcome: "closed", errorMessage: STALE_LONG_FORM_ATTEMPT_CLOSED });
  assert.equal(calls.update?.status, "failed");
  assert.equal(calls.update?.long_form_progress, null);
  assert.equal(calls.update?.error_message, STALE_LONG_FORM_ATTEMPT_CLOSED, "acción «retry»: sin etiqueta de soporte");
  assert.equal(decodeStoredFailure(String(calls.update?.error_message)).action, null);
  assert.deepEqual(calls.filters, ["id=r1", "status=processing", "mode=long_form", "render_attempts=1", "supply_wait_started_at is null",
    `render_started_at=${started}`, `long_form_progress->>updatedAt=${started}`]);
  assert.match(STALE_LONG_FORM_ATTEMPT_CLOSED, /Reintentar/);
  assert.match(STALE_LONG_FORM_ATTEMPT_CLOSED, /25 minutos/);
});

test("Long Form: en cola sin ningún latido (dispatch perdido) también se cierra; sin latido el CAS exige progreso nulo", async () => {
  const row = { ...stuck, render_attempts: 1, long_form_progress: null };
  const { service, calls } = fakeService(1);
  assert.equal(await closeStaleLongFormAttempt(service, row, NOW), "closed");
  assert.ok(calls.filters.includes("long_form_progress is null"));
});

test("Long Form: vivo, en espera de capacidad, de otro modo o ya terminado → no se toca", async () => {
  const { service, calls } = fakeService(1);
  const base = { ...stuck, render_attempts: 1 };
  assert.equal(await closeStaleLongFormAttempt(service, { ...base, long_form_progress: { updatedAt: new Date(NOW - 60_000).toISOString() } }, NOW), "not_applicable");
  assert.equal(await closeStaleLongFormAttempt(service, { ...base, supply_wait_started_at: started }, NOW), "not_applicable");
  assert.equal(await closeStaleLongFormAttempt(service, { ...base, mode: "visual" }, NOW), "not_applicable");
  assert.equal(await closeStaleLongFormAttempt(service, { ...base, status: "completed" }, NOW), "not_applicable");
  assert.equal(calls.update, undefined);
  const { service: raced } = fakeService(0);
  assert.equal(await closeStaleLongFormAttempt(raced, base, NOW), "changed", "el worker volvió a latir entre la lectura y el UPDATE");
});

test("sin intentos restantes sigue siendo el cierre terminal de siempre", async () => {
  const { service, calls } = fakeService(1);
  assert.deepEqual(await closeStaleAttempt(service, stuck, NOW), { outcome: "closed", errorMessage: EXHAUSTED_ATTEMPT_CLOSED });
  assert.equal(calls.update?.error_message, EXHAUSTED_ATTEMPT_CLOSED);
});
