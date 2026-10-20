/**
 * D-RACE — prueba del parche portable ledger-lease.patch (NO aplicado en la rama; requiere decisión del dueño).
 * Se ejecuta con apply-and-test.sh, que aplica el parche en un worktree temporal. Postgres REAL (numeric(12,4)), USD 0.
 *  - N clientes concurrentes sobre la misma clave: 1 llamada, fila COMMITTED, NINGUNA fila RECONCILIATION_REQUIRED,
 *    perdedores = SubmissionInFlightError (o reutilización), reintento posterior reutiliza sin llamar.
 *  - SUBMITTED reciente ajeno: rechazo "en vuelo" SIN mutar la fila.
 *  - SUBMITTED vencido (arrendamiento agotado, sin job id): RECONCILIATION_REQUIRED como hoy (nunca reenvía).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pgClient, pgLedgerStore } from "../../scripts/harness/pg-ledger-store";
import { executePaidOperation, SubmissionInFlightError, ReconciliationRequiredError, SUBMISSION_LEASE_MS } from "@/lib/production-intelligence/ledger";

const URL = process.env.HARNESS_PG_URL;
let db: Awaited<ReturnType<typeof pgClient>>;
const DDL = `drop table if exists public.pi_paid_operations cascade;
create table public.pi_paid_operations (
  idempotency_key text primary key, project_id text not null, shot_id text not null, provider text not null, model text not null,
  method text not null, attempt_kind text not null,
  reserved_usd numeric(12,4) not null check (reserved_usd >= 0), committed_usd numeric(12,4) check (committed_usd is null or committed_usd >= 0),
  status text not null check (status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','COMMITTED','REFUNDED','RECONCILIATION_REQUIRED')),
  provider_job_id text, result_ref text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`;
before(async () => { assert.ok(URL, "HARNESS_PG_URL es obligatorio"); db = await pgClient(URL!); await db.query(DDL); });
after(async () => { await db?.end(); });
beforeEach(async () => { await db.query("truncate public.pi_paid_operations"); });
const OP = { idempotencyKey: "op_race", projectId: "p", shotId: "s", provider: "heygen", model: "m", method: "create", attemptKind: "initial", reservedUsd: 0.0001 };
const now = () => new Date().toISOString();
const rows = async () => (await db.query("select status, provider_job_id from public.pi_paid_operations")).rows;

for (const n of [2, 5, 10]) {
  test(`parche D-RACE: ${n} clientes concurrentes → 1 llamada, COMMITTED, 0 RECONCILIATION_REQUIRED, perdedores «en vuelo»`, async () => {
    let calls = 0; const clients = await Promise.all(Array.from({ length: n }, () => pgClient(URL!)));
    try {
      const port = { async submit() { calls++; await new Promise((r) => setTimeout(r, 40)); return { providerJobId: "job-1" }; }, async poll() { return { resultRef: "ref", actualUsd: 0.0001 }; } };
      const res = await Promise.allSettled(clients.map((c) => executePaidOperation(pgLedgerStore(c), OP, port, now)));
      assert.equal(calls, 1);
      assert.deepEqual(await rows(), [{ status: "COMMITTED", provider_job_id: "job-1" }]);
      for (const r of res) if (r.status === "rejected") assert.ok(r.reason instanceof SubmissionInFlightError || /concurrent submission/.test(String(r.reason?.message)), String(r.reason));
      const again = await executePaidOperation(pgLedgerStore(db), OP, port, now);
      assert.equal(again.status, "COMMITTED"); assert.equal(calls, 1);
    } finally { await Promise.all(clients.map((c) => c.end())); }
  });
}
test("parche D-RACE: SUBMITTED reciente ajeno → SubmissionInFlightError y la fila NO cambia", async () => {
  await db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,updated_at) values ('op_race','p','s','heygen','m','create','initial',0.0001,'SUBMITTED',now() - interval '30 seconds')`);
  let calls = 0; const port = { async submit() { calls++; return { providerJobId: "x" }; }, async poll() { return { resultRef: "r", actualUsd: 0 }; } };
  await assert.rejects(executePaidOperation(pgLedgerStore(db), OP, port, now), (e) => e instanceof SubmissionInFlightError && e instanceof ReconciliationRequiredError);
  assert.equal(calls, 0); assert.deepEqual(await rows(), [{ status: "SUBMITTED", provider_job_id: null }]);
});
test("parche D-RACE: SUBMITTED vencido (sin job id, arrendamiento agotado) → RECONCILIATION_REQUIRED, sin reenviar", async () => {
  await db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,updated_at) values ('op_race','p','s','heygen','m','create','initial',0.0001,'SUBMITTED',now() - make_interval(secs => $1))`, [SUBMISSION_LEASE_MS / 1000 + 60]);
  let calls = 0; const port = { async submit() { calls++; return { providerJobId: "x" }; }, async poll() { return { resultRef: "r", actualUsd: 0 }; } };
  await assert.rejects(executePaidOperation(pgLedgerStore(db), OP, port, now), (e) => e instanceof ReconciliationRequiredError && !(e instanceof SubmissionInFlightError));
  assert.equal(calls, 0); assert.deepEqual(await rows(), [{ status: "RECONCILIATION_REQUIRED", provider_job_id: null }]);
});
test("parche D-RACE: updated_at futuro no extiende el arrendamiento más allá de leaseMs", async () => {
  await db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,updated_at) values ('op_race','p','s','heygen','m','create','initial',0.0001,'SUBMITTED',now() + interval '10 days')`);
  const port = { async submit() { return { providerJobId: "x" }; }, async poll() { return { resultRef: "r", actualUsd: 0 }; } };
  await assert.rejects(executePaidOperation(pgLedgerStore(db), OP, port, now), (e) => !(e instanceof SubmissionInFlightError));
  assert.deepEqual(await rows(), [{ status: "RECONCILIATION_REQUIRED", provider_job_id: null }]);
});
