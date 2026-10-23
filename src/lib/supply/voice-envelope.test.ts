import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceEnvelopeUsd } from "./job";
import { ceilLedgerUsd } from "./anthropic-cost";

test("486 caracteres Reel: la reserva cubre 2 llamadas redondeadas hacia arriba (video 13d20347)", () => {
  for (const rate of [0.1, 0.2, 0.3]) {
    const text = "x".repeat(486);
    const perCall = ceilLedgerUsd(486 / 1000 * rate);
    const env = voiceEnvelopeUsd("visual", text, null, rate);
    assert.ok(env + 1e-12 >= 2 * perCall, `rate ${rate}: ${env} < ${2 * perCall}`);
  }
});
test("barrido 1..3000 caracteres: la reserva nunca es menor que el consumo por llamada", () => {
  for (let n = 1; n <= 3000; n++) for (const mode of ["visual", "avatar"]) {
    const calls = mode === "visual" ? 2 : 1;
    const used = Array.from({ length: calls }, () => ceilLedgerUsd(n / 1000 * 0.2)).reduce((a, b) => a + b, 0);
    assert.ok(voiceEnvelopeUsd(mode, "a".repeat(n), null, 0.2) + 1e-12 >= used);
  }
});
test("long form: suma de techos por beat", () => {
  const beats = [{ narration: "a".repeat(333) }, { narration: "b".repeat(487) }];
  const used = beats.reduce((s, b) => s + ceilLedgerUsd(b.narration.length / 1000 * 0.2), 0);
  assert.ok(voiceEnvelopeUsd("long_form", "", { beats }, 0.2) + 1e-12 >= used);
});
