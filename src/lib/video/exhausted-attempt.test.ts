import { test } from "node:test";
import assert from "node:assert/strict";
import { closeExhaustedStaleAttempt } from "./exhausted-attempt";
import { LONG_FORM_HEARTBEAT_STALE_MS, MAX_RENDER_ATTEMPTS } from "./limits";
import { EXHAUSTED_ATTEMPT_CLOSED } from "./start-outcome";

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
