import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VISUAL_TEST_V2_REAL_MODE_LOCKED,
  VisualTestV2InvalidRequestError,
  VisualTestV2RealModeLockedError,
  parseVisualTestV2RequestBody,
  assertValidVisualTestV2Manifest,
  runVisualTestV2Preflight,
  evaluateVisualTestV2Request,
} from "./visual-test-v2-runtime";
import type { CostLedger } from "./video-cost-guard";

const AUTHORIZED_ENV = {
  LONG_FORM_ENABLED: "true",
  LONG_FORM_ALLOWLIST_EMAILS: "owner@atomivid.test",
};

function tmpDirs() {
  const outputDir = mkdtempSync(join(tmpdir(), "vt2-output-"));
  const ledgerDir = mkdtempSync(join(tmpdir(), "vt2-ledger-"));
  const ledgerPath = join(ledgerDir, "ledger.json");
  return {
    outputDir,
    ledgerPath,
    cleanup: () => {
      rmSync(outputDir, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    },
  };
}

function writeLedger(ledgerPath: string, ledger: CostLedger) {
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// --- VISUAL_TEST_V2_REAL_MODE_LOCKED --------------------------------------

test("VISUAL_TEST_V2_REAL_MODE_LOCKED es true (constante de código, no de entorno)", () => {
  assert.equal(VISUAL_TEST_V2_REAL_MODE_LOCKED, true);
});

// --- parseVisualTestV2RequestBody -----------------------------------------

test("parseVisualTestV2RequestBody acepta exactamente { mode: 'dry_run' }", () => {
  assert.deepEqual(parseVisualTestV2RequestBody({ mode: "dry_run" }), { mode: "dry_run" });
});

test("parseVisualTestV2RequestBody rechaza mode: 'real' con VisualTestV2RealModeLockedError (real mode desactivado → imposible generar)", () => {
  assert.throws(() => parseVisualTestV2RequestBody({ mode: "real" }), VisualTestV2RealModeLockedError);
});

test("parseVisualTestV2RequestBody rechaza cualquier campo extra (no acepta prompts/cantidades arbitrarias)", () => {
  assert.throws(
    () => parseVisualTestV2RequestBody({ mode: "dry_run", prompt: "algo distinto" }),
    VisualTestV2InvalidRequestError,
  );
  assert.throws(
    () => parseVisualTestV2RequestBody({ mode: "dry_run", count: 10 }),
    VisualTestV2InvalidRequestError,
  );
});

test("parseVisualTestV2RequestBody rechaza body no-objeto o null", () => {
  assert.throws(() => parseVisualTestV2RequestBody(null), VisualTestV2InvalidRequestError);
  assert.throws(() => parseVisualTestV2RequestBody("dry_run"), VisualTestV2InvalidRequestError);
  assert.throws(() => parseVisualTestV2RequestBody(undefined), VisualTestV2InvalidRequestError);
});

// --- assertValidVisualTestV2Manifest (manifest inválido → reject) ---------

test("assertValidVisualTestV2Manifest rechaza más de 3 shots", () => {
  assert.throws(
    () =>
      assertValidVisualTestV2Manifest({
        estimatedTotalUsd: 0.1,
        shots: [
          { shotId: "b1-s4" } as never,
          { shotId: "b4-s2" } as never,
          { shotId: "b8-s5" } as never,
          { shotId: "b9-s1" } as never,
        ],
      }),
    VisualTestV2InvalidRequestError,
  );
});

test("assertValidVisualTestV2Manifest rechaza shotIds que no coinciden con los 3 aprobados", () => {
  assert.throws(
    () =>
      assertValidVisualTestV2Manifest({
        estimatedTotalUsd: 0.1,
        shots: [{ shotId: "b1-s4" } as never, { shotId: "b4-s2" } as never, { shotId: "OTRO" } as never],
      }),
    VisualTestV2InvalidRequestError,
  );
});

test("assertValidVisualTestV2Manifest rechaza costo estimado por encima del tope de $0.50", () => {
  assert.throws(
    () =>
      assertValidVisualTestV2Manifest({
        estimatedTotalUsd: 0.51,
        shots: [{ shotId: "b1-s4" } as never, { shotId: "b4-s2" } as never, { shotId: "b8-s5" } as never],
      }),
    VisualTestV2InvalidRequestError,
  );
});

test("assertValidVisualTestV2Manifest no lanza para el manifest real de los 3 shots aprobados", () => {
  assert.doesNotThrow(() =>
    assertValidVisualTestV2Manifest({
      estimatedTotalUsd: 0.15,
      shots: [{ shotId: "b1-s4" } as never, { shotId: "b4-s2" } as never, { shotId: "b8-s5" } as never],
    }),
  );
});

// --- runVisualTestV2Preflight -----------------------------------------------

test("runVisualTestV2Preflight: manifest real (3 shots aprobados), sin ledger previo, sin OPENAI_API_KEY", () => {
  const { outputDir, ledgerPath, cleanup } = tmpDirs();
  try {
    const report = runVisualTestV2Preflight({ env: {}, outputDir, ledgerPath });
    assert.equal(report.mode, "dry_run");
    assert.equal(report.videoId, "gobekli-tepe-001");
    assert.equal(report.openaiApiKeyAvailable, false); // OPENAI_API_KEY ausente → visible en el reporte, no ambiguo
    assert.equal(report.manifestValid, true);
    assert.equal(report.shots.length, 3);
    assert.deepEqual(
      report.shots.map((s) => s.shotId).sort(),
      ["b1-s4", "b4-s2", "b8-s5"].sort(),
    );
    assert.ok(report.shots.every((s) => s.wouldGenerate === true)); // nada existe en outputDir todavía
    assert.equal(report.maxTotalUsd, 0.5);
    assert.equal(report.hardStopUsd, 3.0);
    assert.equal(report.withinCostGuard, true);
    assert.equal(report.alreadySpentTotalUsd, 0);
    assert.equal(report.realModeLocked, true);
    assert.equal(report.paidApisCalled, false);
  } finally {
    cleanup();
  }
});

test("runVisualTestV2Preflight: OPENAI_API_KEY presente → openaiApiKeyAvailable=true, pero el valor nunca aparece en el reporte (secret nunca aparece en response/log)", () => {
  const { outputDir, ledgerPath, cleanup } = tmpDirs();
  try {
    const secret = "sk-super-secret-value-should-never-leak-12345";
    const report = runVisualTestV2Preflight({ env: { OPENAI_API_KEY: secret }, outputDir, ledgerPath });
    assert.equal(report.openaiApiKeyAvailable, true);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secret), false);
  } finally {
    cleanup();
  }
});

test("runVisualTestV2Preflight: costo > $0.50 ya gastado en la categoría visual_test_v2 → withinCostGuard=false, nunca lanza", () => {
  const { outputDir, ledgerPath, cleanup } = tmpDirs();
  try {
    writeLedger(ledgerPath, {
      videoId: "gobekli-tepe-001",
      entries: [
        { timestampIso: new Date().toISOString(), category: "visual_test_v2", amountUsd: 0.45, note: "gasto previo simulado" },
      ],
    });
    const report = runVisualTestV2Preflight({ env: {}, outputDir, ledgerPath });
    assert.equal(report.withinCostGuard, false);
    assert.ok(report.costGuardBlockReason && report.costGuardBlockReason.length > 0);
    assert.equal(report.alreadySpentVisualTestV2Usd, 0.45);
  } finally {
    cleanup();
  }
});

test("runVisualTestV2Preflight: hard stop de VIDEO #001 ($3.00) ya cerca → withinCostGuard=false", () => {
  const { outputDir, ledgerPath, cleanup } = tmpDirs();
  try {
    writeLedger(ledgerPath, {
      videoId: "gobekli-tepe-001",
      entries: [{ timestampIso: new Date().toISOString(), category: "production", amountUsd: 2.9, note: "producción previa simulada" }],
    });
    const report = runVisualTestV2Preflight({ env: {}, outputDir, ledgerPath });
    assert.equal(report.withinCostGuard, false);
  } finally {
    cleanup();
  }
});

test("runVisualTestV2Preflight: llamado dos veces seguidas (mismo outputDir/ledgerPath) es idempotente — no muta el ledger, no cambia wouldGenerate (duplicate/idempotent request → no doble ejecución)", () => {
  const { outputDir, ledgerPath, cleanup } = tmpDirs();
  try {
    const first = runVisualTestV2Preflight({ env: {}, outputDir, ledgerPath });
    const second = runVisualTestV2Preflight({ env: {}, outputDir, ledgerPath });
    assert.deepEqual(first, second);
    assert.equal(second.alreadySpentTotalUsd, 0);
    assert.ok(second.shots.every((s) => s.wouldGenerate === true));
  } finally {
    cleanup();
  }
});

// --- evaluateVisualTestV2Request (decisión completa de la ruta) -----------

test("evaluateVisualTestV2Request: request sin usuario (anónimo) → 401", () => {
  const result = evaluateVisualTestV2Request(null, { mode: "dry_run" });
  assert.equal(result.status, 401);
});

test("evaluateVisualTestV2Request: usuario autenticado pero NO allowlisted → 403 (request sin autorización → reject)", () => {
  const result = evaluateVisualTestV2Request(
    { id: "user-1", email: "nadie@ejemplo.com" },
    { mode: "dry_run" },
    { env: AUTHORIZED_ENV },
  );
  assert.equal(result.status, 403);
});

test("evaluateVisualTestV2Request: LONG_FORM_ENABLED apagado → 403 aunque el email esté en la allowlist", () => {
  const result = evaluateVisualTestV2Request(
    { id: "user-1", email: "owner@atomivid.test" },
    { mode: "dry_run" },
    { env: { LONG_FORM_ENABLED: "false", LONG_FORM_ALLOWLIST_EMAILS: "owner@atomivid.test" } },
  );
  assert.equal(result.status, 403);
});

test("evaluateVisualTestV2Request: usuario autorizado + dry_run → 200 con el reporte de preflight (request autorizado → preflight permitido)", () => {
  const { outputDir, ledgerPath, cleanup } = tmpDirs();
  try {
    const result = evaluateVisualTestV2Request(
      { id: "user-1", email: "owner@atomivid.test" },
      { mode: "dry_run" },
      { env: AUTHORIZED_ENV, outputDir, ledgerPath },
    );
    assert.equal(result.status, 200);
    assert.equal((result.body as { paidApisCalled: boolean }).paidApisCalled, false);
    assert.equal((result.body as { realModeLocked: boolean }).realModeLocked, true);
  } finally {
    cleanup();
  }
});

test("evaluateVisualTestV2Request: usuario autorizado pero mode:'real' → 403, nunca ejecuta preflight ni ninguna generación (real mode desactivado → imposible generar)", () => {
  const result = evaluateVisualTestV2Request(
    { id: "user-1", email: "owner@atomivid.test" },
    { mode: "real" },
    { env: AUTHORIZED_ENV },
  );
  assert.equal(result.status, 403);
});

test("evaluateVisualTestV2Request: body inválido (más de 1 campo) con usuario autorizado → 400", () => {
  const result = evaluateVisualTestV2Request(
    { id: "user-1", email: "owner@atomivid.test" },
    { mode: "dry_run", shots: ["b1-s4"] },
    { env: AUTHORIZED_ENV },
  );
  assert.equal(result.status, 400);
});

test("evaluateVisualTestV2Request: body ausente/no-JSON (null) con usuario autorizado → 400, mensaje seguro", () => {
  const result = evaluateVisualTestV2Request({ id: "user-1", email: "owner@atomivid.test" }, null, {
    env: AUTHORIZED_ENV,
  });
  assert.equal(result.status, 400);
});

// --- Estructural: la ruta HTTP no contiene ningún código de generación
// real (defensa en profundidad, mismo principio que render-route-cas.test.ts:
// confirma en el código fuente que el guard sigue ahí, para que no se
// pierda sin que un test falle) ----------------------------------------

test("route.ts de visual-test-v2 delega toda la decisión en evaluateVisualTestV2Request y no importa ningún proveedor real de imagen", () => {
  const routeSource = readFileSync(
    join(__dirname, "..", "..", "..", "app", "api", "long-form", "visual-test-v2", "route.ts"),
    "utf8",
  );
  assert.ok(routeSource.includes("evaluateVisualTestV2Request"));
  assert.equal(/openaiImageProvider|images\.generate|api\.openai\.com/i.test(routeSource), false);
});
