import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "./circuit-breaker";

test("empieza cerrado y permite operar", () => {
  const cb = new CircuitBreaker(3);
  assert.equal(cb.getState(), "closed");
  assert.doesNotThrow(() => cb.assertClosed());
});

test("se abre tras alcanzar el umbral de fallos consecutivos", () => {
  const cb = new CircuitBreaker(3);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), "closed");
  cb.recordFailure();
  assert.equal(cb.getState(), "open");
  assert.throws(() => cb.assertClosed());
});

test("un éxito reinicia el contador de fallos y cierra el circuito", () => {
  const cb = new CircuitBreaker(3);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.getState(), "closed", "2 fallos después de un éxito no deberían abrir el circuito (umbral=3)");
});

test("respeta un umbral configurado distinto de 3", () => {
  const cb = new CircuitBreaker(1);
  cb.recordFailure();
  assert.equal(cb.getState(), "open");
});
