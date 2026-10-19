import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerUsd, ledgerBillableUsd, LedgerAmountError, LEDGER_USD_MAX } from "./ledger-usd";

test("positivos se redondean HACIA ARRIBA a 0.0001 y nunca a 0", () => {
  for (const [x, y] of [[0.0000001, 0.0001], [0.000001, 0.0001], [0.00004999, 0.0001], [0.00005, 0.0001], [0.0001, 0.0001],
    [0.00010001, 0.0002], [0.0003, 0.0003], [0.1 + 0.2, 0.3], [0.002, 0.002], [12.5, 12.5], [LEDGER_USD_MAX, LEDGER_USD_MAX]] as const)
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
