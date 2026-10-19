import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerUsd, ledgerBillableUsd, LedgerAmountError, LEDGER_USD_MAX } from "./ledger-usd";

test("positivos se redondean HACIA ARRIBA a 0.0001 y nunca a 0", () => {
  for (const [x, y] of [[0.0000001, 0.0001], [0.000001, 0.0001], [0.00004999, 0.0001], [0.00005, 0.0001], [0.0001, 0.0001],
    [0.00010001, 0.0002], [0.0003, 0.0003], [0.1 + 0.2, 0.3001] /* 0.30000000000000004 > 0.3: techo exacto */, [0.002, 0.002], [12.5, 12.5], [LEDGER_USD_MAX, LEDGER_USD_MAX]] as const)
    assert.equal(ledgerUsd(x), y, String(x));
});
test("0 se conserva; billable exige > 0", () => {
  assert.equal(ledgerUsd(0), 0);
  assert.throws(() => ledgerBillableUsd(0), LedgerAmountError);
});
test("NaN, ±Infinity, negativos, no-número y overflow numeric(12,4) → LedgerAmountError", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.0001, -1, 1e8, 99_999_999.99991, "1", null, undefined])
    assert.throws(() => ledgerUsd(bad as never), LedgerAmountError, String(bad));
});

// QA-20261019-1337/1407 (auditoría ChatGPT): el redondeo NUNCA puede quedar por debajo del importe de entrada.
test("frontera: un positivo apenas por encima de una unidad sube a la siguiente (0.00010000001 → 0.0002), nunca baja", () => {
  for (const [x, y] of [[0.00010000001, 0.0002], [0.0001, 0.0001], [0.00019999999, 0.0002], [0.0002, 0.0002], [0.00020000000000001, 0.0003],
    [1e-20, 0.0001], [5e-324, 0.0001], [0.1 + 0.2, 0.3001], [12.50000001, 12.5001], [1.5e-5, 0.0001]] as const)
    assert.equal(ledgerUsd(x), y, String(x));
});
test("propiedad: resultado ≥ entrada, < entrada + 0.0001 y múltiplo exacto de 0.0001 (20 000 valores)", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 20000; i++) {
    const x = [rnd() * 0.001, rnd() * 10, rnd() * 1e6, Math.round(rnd() * 1e6) / 1e4][i % 4];
    if (x === 0) continue;
    const y = ledgerUsd(x);
    assert.ok(y >= x, `${y} < ${x}`);
    assert.ok(y - x < 0.0001 + 1e-9, `${y} − ${x} ≥ 0.0001`);
    assert.equal(String(y), (Math.round(y * 1e4) / 1e4).toString());
  }
});
