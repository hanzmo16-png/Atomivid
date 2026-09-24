import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_TOTAL_BUDGET_USD,
  PER_CLIP_MAX_COST_USD,
  LEDGER_STORAGE_PATH,
  cumulativeBillableSpend,
  evaluateMissionBudget,
  readLedger,
  appendLedgerEntry,
  type P2BLedger,
  type P2BLedgerEntry,
} from "./p2b-mission-ledger";
import { AI_VIDEO_STORAGE_BUCKET } from "./ai-video-storage";

/** Mismo patrón que ai-video-storage.test.ts — fake mínimo de SupabaseClient en memoria. */
function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  const fake = {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            return {
              data: {
                async text() {
                  return buf.toString("utf8");
                },
              },
              error: null,
            };
          },
          async upload(path: string, body: Buffer) {
            files.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, files };
}

function fakeEntry(overrides: Partial<P2BLedgerEntry> = {}): P2BLedgerEntry {
  return {
    attempt: 1,
    timestampIso: "2026-09-24T00:00:00.000Z",
    provider: "veo",
    model: "veo-3.1-fast-generate-preview",
    shotId: "bench-v2-a-pillar-transport",
    reason: "test",
    expectedCostUsd: 0.96,
    actualCostUsd: 0.96,
    result: "success",
    ...overrides,
  };
}

test("MISSION_TOTAL_BUDGET_USD es $10 y PER_CLIP_MAX_COST_USD es $1 (autorización de la misión)", () => {
  assert.equal(MISSION_TOTAL_BUDGET_USD, 10.0);
  assert.equal(PER_CLIP_MAX_COST_USD, 1.0);
});

test("readLedger devuelve entries:[] si el archivo todavía no existe (nunca lanza)", async () => {
  const { fake } = makeFakeSupabase();
  const ledger = await readLedger(fake);
  assert.deepEqual(ledger, { entries: [] });
});

test("readLedger devuelve entries:[] si el JSON almacenado está corrupto (nunca lanza)", async () => {
  const { fake, files } = makeFakeSupabase();
  files.set(LEDGER_STORAGE_PATH, Buffer.from("{ esto no es json válido"));
  const ledger = await readLedger(fake);
  assert.deepEqual(ledger, { entries: [] });
});

test("appendLedgerEntry escribe en la ruta esperada dentro del bucket de video y readLedger la relee correctamente", async () => {
  const { fake, files } = makeFakeSupabase();
  const next = await appendLedgerEntry(fake, fakeEntry({ attempt: 1 }));
  assert.equal(next.entries.length, 1);
  assert.ok(files.has(LEDGER_STORAGE_PATH));
  assert.ok(LEDGER_STORAGE_PATH.startsWith("long-form/"));

  const reread = await readLedger(fake);
  assert.equal(reread.entries.length, 1);
  assert.equal(reread.entries[0].shotId, "bench-v2-a-pillar-transport");
});

test("appendLedgerEntry es acumulativo — dos llamadas sucesivas producen 2 entries, no sobrescriben", async () => {
  const { fake } = makeFakeSupabase();
  await appendLedgerEntry(fake, fakeEntry({ attempt: 1 }));
  const next = await appendLedgerEntry(fake, fakeEntry({ attempt: 2 }));
  assert.equal(next.entries.length, 2);
  assert.deepEqual(next.entries.map((e) => e.attempt), [1, 2]);
});

test("cumulativeBillableSpend ignora entries preflight_blocked (nunca hubo llamada a Google)", () => {
  const ledger: P2BLedger = {
    entries: [
      fakeEntry({ result: "preflight_blocked", actualCostUsd: null, expectedCostUsd: 0.96 }),
      fakeEntry({ result: "success", actualCostUsd: 0.96 }),
    ],
  };
  assert.equal(cumulativeBillableSpend(ledger), 0.96);
});

test("cumulativeBillableSpend usa expectedCostUsd (conservador) cuando actualCostUsd es null en un fallo", () => {
  const ledger: P2BLedger = {
    entries: [fakeEntry({ result: "failure", actualCostUsd: null, expectedCostUsd: 0.96 })],
  };
  assert.equal(cumulativeBillableSpend(ledger), 0.96);
});

test("cumulativeBillableSpend suma múltiples intentos reales (success + failure)", () => {
  const ledger: P2BLedger = {
    entries: [
      fakeEntry({ result: "success", actualCostUsd: 0.96 }),
      fakeEntry({ result: "failure", actualCostUsd: null, expectedCostUsd: 1.0 }),
      fakeEntry({ result: "success", actualCostUsd: 0.96 }),
    ],
  };
  assert.equal(Math.round(cumulativeBillableSpend(ledger) * 100) / 100, 2.92);
});

test("evaluateMissionBudget permite el primer intento (ledger vacío, 0.96 < 10)", () => {
  const decision = evaluateMissionBudget({ entries: [] }, 0.96);
  assert.equal(decision.allowed, true);
});

test("evaluateMissionBudget bloquea cuando acumulado + este intento alcanza o supera $10 (hard stop)", () => {
  const ledger: P2BLedger = {
    entries: Array.from({ length: 9 }, (_, i) => fakeEntry({ attempt: i + 1, actualCostUsd: 1.0, expectedCostUsd: 1.0 })),
  };
  // 9 * $1.00 = $9.00 acumulado; + $1.00 más = $10.00 >= $10.00 techo -> bloqueado.
  const decision = evaluateMissionBudget(ledger, 1.0);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.match(decision.detail, /\$10\.00/);
  }
});

test("evaluateMissionBudget permite justo por debajo del techo ($9.00 acumulado + $0.96 < $10.00)", () => {
  const ledger: P2BLedger = {
    entries: Array.from({ length: 9 }, (_, i) => fakeEntry({ attempt: i + 1, actualCostUsd: 1.0, expectedCostUsd: 1.0 })),
  };
  const decision = evaluateMissionBudget(ledger, 0.96);
  assert.equal(decision.allowed, true);
});

test("LEDGER_STORAGE_PATH vive en el mismo bucket que el resto de Long Form Storage (AI_VIDEO_STORAGE_BUCKET), nunca infraestructura nueva", () => {
  assert.equal(AI_VIDEO_STORAGE_BUCKET, "videos");
  assert.ok(LEDGER_STORAGE_PATH.includes("gobekli-tepe-ai-video-benchmark-v2-active"));
});
