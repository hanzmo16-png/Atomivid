import { test } from "node:test";
import assert from "node:assert/strict";
import { PaidBudgetExceededError, PaidLedger, memoryLedgerStore, summarizeLedger, type PaidLedgerStore } from "./paid-ledger";
import { SampleBudgetStopError, runSamplesSerially } from "./sample-runner";
import type { SampleEstimate } from "./sample-plan";

/**
 * Runner de muestras con registros durables en memoria y un «pipeline»
 * simulado que compromete gasto real en el registro — cero red, cero gasto.
 */
const estimate = (id: string, reserveUsd: number): SampleEstimate => ({ id, images: 0, reserveUsd, typicalUsd: reserveUsd, lines: [] });

function durableLedgers(ids: string[]) {
  const stores: Record<string, PaidLedgerStore & { saved: unknown[] }> = Object.fromEntries(ids.map((id) => [id, memoryLedgerStore()]));
  return {
    stores,
    async loadCommitted() {
      const out: Record<string, number> = {};
      for (const [id, store] of Object.entries(stores)) {
        const state = await store.load();
        if (state) out[id] = summarizeLedger(state).committedUsd;
      }
      return out;
    },
    openLedger: (id: string, capUsd: number) => PaidLedger.open(stores[id], { scope: id, capUsd }),
  };
}

const spend = (ledger: PaidLedger, key: string, usd: number) =>
  ledger.run({ key, kind: "image", provider: "fake", reserveUsd: usd }, async () => ({ value: null, settle: { actualUsd: usd, costBasis: "provider_usage" as const } }), () => "uncertain");

test("runner: total US$1 y la primera compromete US$0,62 → la segunda (peor caso US$0,62) no arranca", async () => {
  const caps = { totalUsd: 1, perSampleUsd: 0.75 };
  const d = durableLedgers(["a", "b"]);
  const produced: string[] = [];
  const decisions: Record<string, unknown>[] = [];
  await assert.rejects(
    runSamplesSerially({
      sampleIds: ["a", "b"],
      caps,
      estimates: { a: estimate("a", 0.62), b: estimate("b", 0.62) },
      loadCommitted: d.loadCommitted,
      openLedger: d.openLedger,
      produce: async (id, ledger) => {
        produced.push(id);
        await spend(ledger, `${id}:todo`, 0.62);
      },
      log: (_event, data) => decisions.push(data),
    }),
    (err: unknown) => err instanceof SampleBudgetStopError && err.sampleId === "b" && /no queda presupuesto suficiente/.test(err.message),
  );
  assert.deepEqual(produced, ["a"]);
  assert.equal(decisions[0].effectiveCapUsd, 0.75);
  assert.equal(decisions[1].effectiveCapUsd, 0.38, "tope efectivo recalculado con el gasto de la primera");
  assert.deepEqual(decisions[1].committedBySample, { a: 0.62 });
  const total = Object.values(await d.loadCommitted()).reduce((x, y) => x + y, 0);
  assert.ok(total <= caps.totalUsd, `total ${total}`);
});

test("runner: si la segunda arranca (estimación baja), su registro recibe el tope recalculado y no puede comprometer otros US$0,62", async () => {
  const caps = { totalUsd: 1, perSampleUsd: 0.75 };
  const d = durableLedgers(["a", "b"]);
  let secondError: unknown;
  await runSamplesSerially({
    sampleIds: ["a", "b"],
    caps,
    // La estimación de «b» se queda corta: el registro es la última barrera.
    estimates: { a: estimate("a", 0.62), b: estimate("b", 0.2) },
    loadCommitted: d.loadCommitted,
    openLedger: d.openLedger,
    produce: async (id, ledger) => {
      if (id === "a") return void (await spend(ledger, "a:todo", 0.62));
      await spend(ledger, "b:1", 0.31);
      await spend(ledger, "b:2", 0.31).catch((err) => (secondError = err));
    },
  });
  assert.ok(secondError instanceof PaidBudgetExceededError, "la operación que superaría el total se bloquea antes de llamar");
  const committed = await d.loadCommitted();
  assert.deepEqual(committed, { a: 0.62, b: 0.31 });
  assert.equal((await d.stores.b.load())!.capUsd, 0.38);
});

test("runner: ejecución serial — la segunda muestra no empieza hasta que la primera termina", async () => {
  const d = durableLedgers(["a", "b"]);
  const events: string[] = [];
  await runSamplesSerially({
    sampleIds: ["a", "b"],
    caps: { totalUsd: 3.5, perSampleUsd: 0.75 },
    estimates: { a: estimate("a", 0.1), b: estimate("b", 0.1) },
    loadCommitted: d.loadCommitted,
    openLedger: d.openLedger,
    produce: async (id) => {
      events.push(`inicio ${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`fin ${id}`);
    },
  });
  assert.deepEqual(events, ["inicio a", "fin a", "inicio b", "fin b"]);
});
