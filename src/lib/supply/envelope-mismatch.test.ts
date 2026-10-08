import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JobEnvelopeMismatchError, reserveJobSupply } from "./job";
import { SupplyUnavailableError } from "./policy";
import { isCustomerSafeError } from "@/lib/video/long-form/output-policy";

process.env.SUPPLY_GUARD_ENFORCED = "true";
const rpc = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as never;
const demand = [{ provider: "heygen", unit: "usd" as const, units: 5, usd: 5 }];

// Regression (avatar 6dad04ec, 2026-10-08): Vercel reserved USD 2, the worker demanded USD 5 and
// "job envelope changed" was turned into an endless "waiting for availability".
test("sobre de reserva menor que la demanda del worker: error de configuración, nunca espera por saldo", async () => {
  const err = await reserveJobSupply(rpc({ reserved: false, reason: "job envelope changed", provider: "heygen" }), "r", 1, demand).catch((e) => e);
  assert.ok(err instanceof JobEnvelopeMismatchError);
  assert.ok(!(err instanceof SupplyUnavailableError), "must not take the supply-wait branch");
  assert.equal(err.provider, "heygen");
  assert.ok(isCustomerSafeError(err));
  assert.match(err.customerMessage, /No se generó ni se cobró nada/);
});

test("falta real de saldo sigue siendo espera por disponibilidad", async () => {
  const err = await reserveJobSupply(rpc({ reserved: false, reason: "supplier balance unavailable", provider: "heygen" }), "r", 1, demand).catch((e) => e);
  assert.ok(err instanceof SupplyUnavailableError);
  await reserveJobSupply(rpc({ reserved: true }), "r", 1, demand);
});

test("worker: solo SupplyUnavailableError espera; el desajuste va a fallo claro y la cola no lo reenvía", () => {
  const runJob = readFileSync(path.join(__dirname, "../video/run-job.ts"), "utf8");
  assert.match(runJob, /if \(error instanceof SupplyUnavailableError\) \{\s*const waiting/);
  const queue = readFileSync(path.join(__dirname, "queue.ts"), "utf8");
  assert.match(queue, /error instanceof JobEnvelopeMismatchError\) \{[\s\S]{0,200}?continue; \}/);
  const yml = readFileSync(path.join(__dirname, "../../../.github/workflows/render.yml"), "utf8");
  assert.match(yml, /MAX_AVATAR_COST_USD: '2'/, "the worker's per-production avatar cap equals the app's (USD 2)");
});

test("envío pagado con saldo vencido: una sola relectura del proveedor y nueva evaluación atómica; nunca más", async () => {
  const { submitWithSupply } = await import("./server");
  const op = { idempotencyKey: "k", provider: "heygen", reservedUsd: 2, capacityUnits: 2 } as never;
  const answers = [{ submitted: false, reason: "balance unverified or stale" }, { submitted: true, reason: "admitted" }];
  let rpcCalls = 0, refreshes = 0;
  const svc = { rpc: async () => ({ data: answers[rpcCalls++], error: null }) } as never;
  assert.equal(await submitWithSupply(svc, op, { refresh: async () => { refreshes++; return true; } }), true);
  assert.deepEqual([rpcCalls, refreshes], [2, 1]);
  // Refresh impossible (no credential/provider down): still refused, no second submit.
  rpcCalls = 0;
  const stale = { rpc: async () => { rpcCalls++; return { data: { submitted: false, reason: "balance unverified or stale" }, error: null }; } } as never;
  await assert.rejects(submitWithSupply(stale, op, { refresh: async () => false }), (e: unknown) => e instanceof SupplyUnavailableError);
  assert.equal(rpcCalls, 1);
  // Non-refreshable providers (manual balances) are never "refreshed".
  let touched = false;
  await assert.rejects(submitWithSupply(stale, { ...(op as object), provider: "openai" } as never, { refresh: async () => { touched = true; return true; } }));
  assert.equal(touched, false);
});
