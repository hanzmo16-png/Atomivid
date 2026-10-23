import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceEnvelopeUsd } from "./job";
import { ledgerUsd as ceilLedgerUsd } from "@/lib/paid-calls/ledger-usd";

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

// Auditoría P2.1: la reserva se comparaba con un redondeo tolerante (ceilLedgerUsd) mientras el gate registra cada
// llamada con ledgerUsd (techo estricto): 486+100 caracteres a 0.2 → reserva 0.1172 < 0.0973 + 0.0201 consumidos.
test("long form: beats 486+100 a 0.2 → la reserva cubre lo que el gate registra por llamada", () => {
  const beats = [{ narration: "a".repeat(486) }, { narration: "b".repeat(100) }];
  assert.ok(voiceEnvelopeUsd("long_form", beats.map((b) => b.narration).join(" "), { beats }, 0.2) >= 0.0973 + 0.0201 - 1e-12);
});
test("barrido aleatorio long form (beats 1..2500) y Reel/Avatar (1..5000): reserva ≥ Σ ledgerUsd por llamada", () => {
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (const rate of [0.1, 0.2, 0.3]) {
    for (let i = 0; i < 3000; i++) {
      const beats = Array.from({ length: 1 + Math.floor(rnd() * 60) }, () => ({ narration: "x".repeat(1 + Math.floor(rnd() * 2500)) }));
      const used = beats.reduce((s, b) => s + ceilLedgerUsd(b.narration.length / 1000 * rate), 0);
      assert.ok(voiceEnvelopeUsd("long_form", beats.map((b) => b.narration).join(" "), { beats }, rate) + 1e-9 >= used);
    }
    for (let n = 1; n <= 5000; n++) for (const mode of ["visual", "avatar"]) {
      const calls = mode === "visual" ? 2 : 1;
      assert.ok(voiceEnvelopeUsd(mode, "a".repeat(n), null, rate) + 1e-9 >= calls * ceilLedgerUsd(n / 1000 * rate), `${mode} ${n} ${rate}`);
    }
  }
});
test("nunca menor que la estimación previa (total bruto)", () => {
  for (let n = 1; n <= 3000; n += 7) assert.ok(voiceEnvelopeUsd("visual", "a".repeat(n), null, 0.2) >= n * 2 / 1000 * 0.2);
});
