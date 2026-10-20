/**
 * Concurrencia/respuesta perdida (D-RACE corregido en T-20261019-1602; antes este archivo quedaba ROJO) contra Postgres REAL con los tipos de la migración 0023
 * (reserved_usd/committed_usd numeric(12,4)). USD 0: todos los proveedores son mocks.
 * Ejecutar: HARNESS_PG_URL=postgres://postgres@/x?host=/tmp&port=55432 node --import tsx --test scripts/harness/ledger-precision.pg.test.ts
 * Sin HARNESS_PG_URL el test FALLA (no se salta en silencio).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pgClient, pgLedgerStore } from "./pg-ledger-store";
import { ledgerGuardedCreateAvatar, configuredAvatarCreationCostUsd } from "@/lib/video/avatar/create-avatar-ledger";
import { gatedMusicTrack, gatedVoiceSynthesize } from "@/lib/paid-calls/gated-providers";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import type { MusicProvider, VoiceProvider } from "@/lib/providers/types";

const URL = process.env.HARNESS_PG_URL;
let db: Awaited<ReturnType<typeof pgClient>>;
const DDL = `
create or replace function public.pi_reject_mutation() returns trigger language plpgsql as $$ begin raise exception 'append-only'; end $$;
drop table if exists public.pi_paid_operations cascade;
create table public.pi_paid_operations (
  idempotency_key text primary key, project_id text not null, shot_id text not null, provider text not null, model text not null,
  method text not null, attempt_kind text not null,
  reserved_usd numeric(12,4) not null check (reserved_usd >= 0),
  committed_usd numeric(12,4) check (committed_usd is null or committed_usd >= 0),
  status text not null check (status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','COMMITTED','REFUNDED','RECONCILIATION_REQUIRED')),
  provider_job_id text, result_ref text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`;

before(async () => {
  assert.ok(URL, "HARNESS_PG_URL es obligatorio: este test no se salta en silencio");
  db = await pgClient(URL!);
  await db.query(DDL);
});
after(async () => { await db?.end(); });
beforeEach(async () => { await db.query("truncate public.pi_paid_operations"); });

async function rows() {
  const r = await db.query("select status, reserved_usd::text r, committed_usd::text c from public.pi_paid_operations order by created_at");
  return r.rows as { status: string; r: string; c: string | null }[];
}

async function avatarRun(rate: string) {
  let calls = 0;
  const env = { PRICING_HEYGEN_CREATE_AVATAR_USD: rate };
  const ledger = pgLedgerStore(db);
  const run = () => ledgerGuardedCreateAvatar(ledger, "req-precision", "heygen", "sha-photo",
    async () => { calls++; return { avatarId: "av1" } as never; },
    { verifiedCostUsd: configuredAvatarCreationCostUsd("heygen", env) });
  return { run, get calls() { return calls; } };
}

// Positivos diminutos y fronteras: nunca 0.0000 en el ledger tras una llamada facturable.
const CASES: [string, string][] = [
  ["0.0000001", "0.0001"], ["0.000001", "0.0001"], ["0.00004999", "0.0001"], ["0.00005", "0.0001"],
  ["0.0001", "0.0001"], ["0.00010001", "0.0002"], ["0.0003", "0.0003"], ["0.35", "0.3500"], ["12.5", "12.5000"], ["99999999.9999", "99999999.9999"],
];
for (const [rate, stored] of CASES) {
  test(`avatar tarifa ${rate} → 1 llamada, COMMITTED, reserved=committed=${stored} (nunca 0)`, async () => {
    const a = await avatarRun(rate);
    await a.run();
    assert.equal(a.calls, 1);
    const rs = await rows();
    assert.equal(rs.length, 1);
    assert.equal(rs[0].status, "COMMITTED");
    assert.equal(rs[0].r, stored);
    assert.equal(rs[0].c, stored);
    assert.notEqual(rs[0].c, "0.0000");
    // Reutilización: segunda ejecución no llama ni escribe otra fila.
    await a.run();
    assert.equal(a.calls, 1);
    assert.equal((await rows()).length, 1);
  });
}

for (const bad of ["0", "-0.01", "", "  ", "NaN", "Infinity", "-Infinity", "abc", "100000000", "1e9"]) {
  test(`avatar tarifa inválida/no representable "${bad}" → rechazo antes del proveedor, 0 filas`, async () => {
    let calls = 0;
    assert.throws(() => configuredAvatarCreationCostUsd("heygen", { PRICING_HEYGEN_CREATE_AVATAR_USD: bad }));
    // También por la vía verifiedCostUsd explícita (sin pasar por la env).
    const n = Number(bad);
    await assert.rejects(ledgerGuardedCreateAvatar(pgLedgerStore(db), "req-bad", "heygen", "sha", async () => { calls++; return {} as never; }, { verifiedCostUsd: n }));
    assert.equal(calls, 0);
    assert.equal((await rows()).length, 0);
  });
}


// Concurrencia con N clientes (conexiones PG independientes) sobre la misma clave de avatar.
for (const n of [2, 5, 10]) {
  test(`concurrencia ${n} clientes → exactamente 1 llamada, 1 fila COMMITTED 0.0001; perdedores clasificados`, async () => {
    let calls = 0;
    const clients = await Promise.all(Array.from({ length: n }, () => pgClient(URL!)));
    try {
      const results = await Promise.allSettled(clients.map((c) => ledgerGuardedCreateAvatar(pgLedgerStore(c), "req-cc", "heygen", "sha-cc",
        async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { avatarId: "av" } as never; }, { verifiedCostUsd: 0.000001 })));
      assert.equal(calls, 1);
      assert.deepEqual(await rows(), [{ status: "COMMITTED", r: "0.0001", c: "0.0001" }]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const losers = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.constructor?.name);
      assert.ok(ok >= 1);
      // Los perdedores reciben SubmissionInFlightError («en curso», subclase de ReconciliationRequiredError): no hay
      // nada que reconciliar y la fila del ganador no se toca.
      for (const name of losers) assert.equal(name, "SubmissionInFlightError");
      // Reintento posterior de un perdedor: reutiliza sin llamar.
      await ledgerGuardedCreateAvatar(pgLedgerStore(db), "req-cc", "heygen", "sha-cc", async () => { calls++; return {} as never; }, { verifiedCostUsd: 0.000001 });
      assert.equal(calls, 1);
    } finally { await Promise.all(clients.map((c) => c.end())); }
  });
}

test("respuesta perdida tras aceptar el proveedor → RECONCILIATION_REQUIRED, reserva 0.0001 conservada, reintento sin nueva llamada", async () => {
  let calls = 0;
  const ledger = pgLedgerStore(db);
  await assert.rejects(ledgerGuardedCreateAvatar(ledger, "req-lost", "heygen", "sha-lost", async () => { calls++; throw new Error("socket hang up"); }, { verifiedCostUsd: 0.000001 }));
  assert.deepEqual(await rows(), [{ status: "RECONCILIATION_REQUIRED", r: "0.0001", c: null }]);
  await assert.rejects(ledgerGuardedCreateAvatar(ledger, "req-lost", "heygen", "sha-lost", async () => { calls++; return {} as never; }, { verifiedCostUsd: 0.000001 }));
  assert.equal(calls, 1);
  assert.equal((await rows()).length, 1);
});
