import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCanSpend,
  emptyLedger,
  recordSpend,
  totalSpentUsd,
  spentUsdByCategory,
  VideoCostGuardExceededError,
  VISUAL_TEST_V2_MAX_USD,
  VIDEO_001_HARD_STOP_USD,
  readCostLedgerFromDisk,
  recordSpendToDisk,
} from "./video-cost-guard";

test("emptyLedger/totalSpentUsd: un ledger nuevo tiene gasto total 0", () => {
  const ledger = emptyLedger("gobekli-tepe-001");
  assert.equal(totalSpentUsd(ledger), 0);
});

test("assertCanSpend permite un gasto dentro de ambos topes", () => {
  const ledger = emptyLedger("gobekli-tepe-001");
  assert.doesNotThrow(() => assertCanSpend(ledger, "visual_test_v2", 0.15));
});

test("assertCanSpend lanza VideoCostGuardExceededError('visual_test_v2_cap') si excede $0.50 en esa categoría, aunque el hard stop total no se toque", () => {
  const ledger = emptyLedger("gobekli-tepe-001");
  assert.throws(
    () => assertCanSpend(ledger, "visual_test_v2", VISUAL_TEST_V2_MAX_USD + 0.01),
    (err: unknown) => err instanceof VideoCostGuardExceededError && err.reason === "visual_test_v2_cap",
  );
});

test("assertCanSpend lanza VideoCostGuardExceededError('hard_stop') si el TOTAL acumulado supera $3.00, aunque la categoría individual esté bien", () => {
  let ledger = emptyLedger("gobekli-tepe-001");
  ledger = recordSpend(ledger, "production", 2.9, "gasto previo simulado");
  assert.throws(
    () => assertCanSpend(ledger, "production", 0.2),
    (err: unknown) => err instanceof VideoCostGuardExceededError && err.reason === "hard_stop",
  );
});

test("recordSpend re-valida assertCanSpend antes de anotar — nunca anota un gasto que rompería el guard", () => {
  const ledger = emptyLedger("gobekli-tepe-001");
  assert.throws(() => recordSpend(ledger, "visual_test_v2", 10, "gasto imposible"), VideoCostGuardExceededError);
});

test("recordSpend acumula correctamente y spentUsdByCategory distingue categorías", () => {
  let ledger = emptyLedger("gobekli-tepe-001");
  ledger = recordSpend(ledger, "visual_test_v2", 0.15, "3 imágenes de prueba");
  ledger = recordSpend(ledger, "production", 1.16, "TTS completo");
  assert.equal(totalSpentUsd(ledger), 1.31);
  assert.equal(spentUsdByCategory(ledger, "visual_test_v2"), 0.15);
  assert.equal(spentUsdByCategory(ledger, "production"), 1.16);
});

test("VIDEO_001_HARD_STOP_USD y VISUAL_TEST_V2_MAX_USD tienen los valores autorizados exactos", () => {
  assert.equal(VISUAL_TEST_V2_MAX_USD, 0.5);
  assert.equal(VIDEO_001_HARD_STOP_USD, 3.0);
});

test("readCostLedgerFromDisk devuelve un ledger vacío (nunca lanza) si el archivo todavía no existe", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-cost-guard-test-"));
  try {
    const path = join(dir, "no-existe.json");
    const ledger = readCostLedgerFromDisk("gobekli-tepe-001", path);
    assert.equal(totalSpentUsd(ledger), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordSpendToDisk persiste sincrónicamente, y una lectura posterior (simulando un proceso nuevo) ve el gasto acumulado — así un reintento no puede superar el hard stop", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-cost-guard-test-"));
  try {
    const path = join(dir, "ledger.json");
    recordSpendToDisk("gobekli-tepe-001", "production", 2.5, "primera llamada real", path);
    assert.ok(existsSync(path));

    // Simula un proceso NUEVO leyendo el mismo archivo — nunca depende de
    // estado en memoria del proceso anterior.
    const reloaded = readCostLedgerFromDisk("gobekli-tepe-001", path);
    assert.equal(totalSpentUsd(reloaded), 2.5);

    // Un segundo gasto que llevaría el total a 2.5+0.6=3.1 > 3.00 debe
    // bloquearse, incluso viniendo de una invocación "fresca".
    assert.throws(
      () => recordSpendToDisk("gobekli-tepe-001", "production", 0.6, "reintento accidental", path),
      VideoCostGuardExceededError,
    );

    // Y el archivo en disco NO debe haber cambiado tras el intento bloqueado.
    const afterBlocked = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(afterBlocked.entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCostLedgerFromDisk lanza si el archivo pertenece a otro videoId — nunca mezcla gastos de dos videos", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-cost-guard-test-"));
  try {
    const path = join(dir, "ledger.json");
    recordSpendToDisk("otro-video-002", "production", 0.1, "gasto de otro video", path);
    assert.throws(() => readCostLedgerFromDisk("gobekli-tepe-001", path), /pertenece a videoId="otro-video-002"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
