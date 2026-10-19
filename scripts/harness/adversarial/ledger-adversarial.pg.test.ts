/**
 * F1-B (T-20261019-1602) — Pruebas adversarias del ledger sobre PostgreSQL EFÍMERO con el esquema REAL
 * (pg_dump --schema-only de la base local con TODAS las migraciones: trigger forward-only, numeric(12,4),
 * RPC pi_submit_with_supply / _core). USD 0: proveedores mock en memoria; el egreso no-loopback está cerrado.
 *
 * Qué es real: executePaidOperation + guardPaidCall (gate.ts) + submitWithSupply (supply/server.ts) + SQL del RPC.
 * Qué es sustituto: el transporte PostgREST. get/insert/update usan pg-ledger-store (mismo CAS por status,
 * mismo 23505→false) y `service.rpc(name,args)` se traduce a `select public.name(...)` sobre la misma conexión.
 *
 * Evidencia: tabla de auditoría alimentada por trigger AFTER UPDATE/INSERT (cada transición de estado con importes)
 * y lectura final de filas; no sólo contadores de llamadas.
 * Ejecutar: scripts/harness/adversarial/run.sh  (crea la BD efímera, ejecuta, la borra).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pgClient, pgLedgerStore } from "../pg-ledger-store";
import { guardPaidCall, type PaidCallSpec, type PaidCallHooks, ReconciliationRequiredError } from "@/lib/paid-calls/gate";
import { SubmissionInFlightError, flagStaleSubmission, reconcileWithProviderEvidence, type LedgerStore } from "@/lib/production-intelligence/ledger";
import { submitWithSupply } from "@/lib/supply/server";
import { GenerativeProviderError } from "@/lib/providers/types";

const URL = process.env.ADV_PG_URL;
type Db = Awaited<ReturnType<typeof pgClient>>;
let admin: Db;
const PROVIDER = "mockvoice";

// Egreso cerrado: cualquier fetch no-loopback falla y queda registrado.
const egress: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new globalThis.URL(typeof input === "string" ? input : input instanceof globalThis.URL ? input.href : input.url);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) { egress.push(u.href); throw new Error(`egress blocked: ${u.hostname}`); }
  return realFetch(input, init);
}) as typeof fetch;

function rpcShim(db: Db) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      if (!/^pi_[a-z_]+$/.test(name)) return { data: null, error: { message: "rpc not allowed" } };
      const keys = Object.keys(args);
      try {
        const r = await db.query(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) as v`, keys.map((k) => args[k]));
        return { data: r.rows[0].v, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
  } as never;
}

/** Store productivo equivalente: CAS de pg-ledger-store + submit = submitWithSupply real (RPC real). */
function store(db: Db): LedgerStore {
  const s = pgLedgerStore(db, { withSubmit: false });
  s.submit = (op) => submitWithSupply(rpcShim(db), op);
  return s;
}

before(async () => {
  assert.ok(URL, "ADV_PG_URL es obligatorio (no se salta en silencio)");
  admin = await pgClient(URL!);
  await admin.query(`
    create table if not exists public.adv_audit(id bigserial primary key, key text, old_status text, new_status text, reserved numeric, committed numeric, job text, at timestamptz default clock_timestamp());
    create or replace function public.adv_audit_fn() returns trigger language plpgsql as $$ begin
      insert into public.adv_audit(key,old_status,new_status,reserved,committed,job) values (new.idempotency_key, case when tg_op='INSERT' then null else old.status end, new.status, new.reserved_usd, new.committed_usd, new.provider_job_id);
      return new; end $$;
    drop trigger if exists adv_audit_t on public.pi_paid_operations;
    create trigger adv_audit_t after insert or update on public.pi_paid_operations for each row execute function public.adv_audit_fn();
    insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
    values ('__global__','adversarial local','none','NO_SECRET','unknown','none'), ('${PROVIDER}','adversarial local mock','none','NO_SECRET','unknown','none')
    on conflict (provider) do nothing;
    insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,free_daily_cap_usd,timezone,evidence)
    values ('__global__',true,'usd',100,1,1,50,200,50,10000,0,'America/Cancun','adversarial local USD 0'),
           ('${PROVIDER}',true,'usd',100,1,1,50,200,50,10000,0,'America/Cancun','adversarial local USD 0 (mock)')
    on conflict (provider) do update set enabled=true, daily_cap_usd=50, monthly_cap_usd=200, max_concurrent=50, max_daily_calls=10000, evidence=excluded.evidence;`);
  await setBalance(100);
});
async function exportCsv(dir: string) {
  // Evidencia: filas reales del ledger (pi_paid_operations) y su historial de transiciones (trigger adv_audit), sin secretos.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  for (const [file, sql] of [
    ["ledger_ops.csv", `select project_id, idempotency_key, provider, method, attempt_kind, status, reserved_usd::text, committed_usd::text, provider_job_id, created_at, updated_at from public.pi_paid_operations order by project_id, created_at`],
    ["ledger_transitions.csv", `select a.id, o.project_id, a.key, a.old_status, a.new_status, a.reserved::text, a.committed::text, a.job, a.at from public.adv_audit a left join public.pi_paid_operations o on o.idempotency_key=a.key order by a.id`],
  ] as const) {
    const r = await admin.query(sql);
    const cols = r.fields.map((f: { name: string }) => f.name);
    writeFileSync(`${dir}/${file}`, [cols.join(","), ...r.rows.map((row: Record<string, unknown>) => cols.map((c: string) => esc(row[c])).join(","))].join("\n") + "\n");
  }
}
after(async () => { if (process.env.ADV_CSV_DIR && admin) await exportCsv(process.env.ADV_CSV_DIR); await admin?.end(); globalThis.fetch = realFetch; });

async function setBalance(available: number, opts: { ageMinutes?: number; health?: string; reliability?: string } = {}) {
  await admin.query(`insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at)
    values ($1,'usd',$2,0,0,$3,$5,'GREEN', now() - make_interval(mins => $4))`, [PROVIDER, available, opts.health ?? "OK", opts.ageMinutes ?? 0, opts.reliability ?? "manual_entry"]);
}

let seq = 0;
function spec(tag: string, usd = 0.05): PaidCallSpec {
  return { projectId: `adv-${tag}-${++seq}`, shotId: "voice:s1", provider: PROVIDER, model: "m1", method: "synthesize", inputFingerprint: { text: tag }, reservedUsd: usd };
}

type Mock = { calls: number; hooks: PaidCallHooks<string> };
function mockProvider(behavior: (n: number) => Promise<{ costUsd: number; jobId?: string }>): Mock {
  const m: Mock = { calls: 0, hooks: {
    call: async () => { const n = ++m.calls; const r = await behavior(n); return { result: `audio-${n}`, costUsd: r.costUsd, resultRef: `ref:audio-${n}`, providerJobId: r.jobId }; },
    load: async (ref) => ref.replace("ref:", ""),
  } };
  return m;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rowsOf(projectId: string) {
  const r = await admin.query(`select idempotency_key k, status, reserved_usd::text r, committed_usd::text c, provider_job_id j from public.pi_paid_operations where project_id=$1`, [projectId]);
  return r.rows as { k: string; status: string; r: string; c: string | null; j: string | null }[];
}
async function auditOf(key: string) {
  const r = await admin.query(`select old_status o, new_status n, committed::text c from public.adv_audit where key=$1 order by id`, [key]);
  return r.rows as { o: string | null; n: string; c: string | null }[];
}
/** Invariantes globales sobre TODA la tabla. */
async function invariants() {
  const neg = await admin.query(`select count(*)::int n from public.pi_paid_operations where reserved_usd < 0 or committed_usd < 0`);
  assert.equal(neg.rows[0].n, 0, "reserva/compromiso negativo");
  const dup = await admin.query(`select key, count(*)::int n from public.adv_audit where new_status='COMMITTED' and old_status is distinct from 'COMMITTED' group by key having count(*)>1`);
  assert.equal(dup.rows.length, 0, "liquidación duplicada");
  const zero = await admin.query(`select count(*)::int n from public.pi_paid_operations where status='COMMITTED' and committed_usd = 0 and result_ref like 'ref:%'`);
  assert.equal(zero.rows[0].n, 0, "importe facturable positivo guardado como 0");
}

async function race(n: number, sp: PaidCallSpec, m: Mock) {
  const clients = await Promise.all(Array.from({ length: n }, () => pgClient(URL!)));
  try { return await Promise.allSettled(clients.map((c) => guardPaidCall(store(c), sp, m.hooks))); }
  finally { await Promise.all(clients.map((c) => c.end())); }
}
const names = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as Error).constructor.name);

for (const n of [2, 5, 10]) {
  test(`[${n}] concurrencia feliz: 1 llamada, el ganador liquida, perdedores «en curso» SIN mutar la fila, reintento reutiliza`, async () => {
    const sp = spec(`ok${n}`);
    const m = mockProvider(async () => { await sleep(80); return { costUsd: 0.04 }; });
    const rs = await race(n, sp, m);
    assert.equal(m.calls, 1);
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1, "el ganador conserva su resultado pagado");
    for (const nm of names(rs)) assert.equal(nm, "SubmissionInFlightError");
    const [row] = await rowsOf(sp.projectId);
    assert.deepEqual({ s: row.status, r: row.r, c: row.c }, { s: "COMMITTED", r: "0.0500", c: "0.0400" });
    const audit = await auditOf(row.k);
    assert.deepEqual(audit.map((a) => a.n), ["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "COMMITTED"], "sin RECONCILIATION_REQUIRED artificial");
    const again = await guardPaidCall(store(admin), sp, m.hooks);
    assert.equal(again.reused, true); assert.equal(m.calls, 1);
    await invariants();
  });

  test(`[${n}] respuesta perdida tras aceptación del proveedor → RECONCILIATION_REQUIRED; ${n} reintentos concurrentes: 0 envíos; evidencia del proveedor → COMMITTED; reutiliza`, async () => {
    const sp = spec(`lost${n}`);
    const m = mockProvider(async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); });
    await assert.rejects(guardPaidCall(store(admin), sp, m.hooks));
    let [row] = await rowsOf(sp.projectId);
    assert.equal(row.status, "RECONCILIATION_REQUIRED"); assert.equal(row.r, "0.0500"); assert.equal(row.c, null);
    const rs = await race(n, sp, m);
    assert.equal(m.calls, 1, "ningún reenvío con resultado desconocido");
    for (const r of rs) assert.equal(r.status, "rejected");
    for (const nm of names(rs)) assert.ok(nm === "ReconciliationRequiredError", nm);
    // El tiempo transcurrido no se usa; sólo evidencia del proveedor resuelve.
    await reconcileWithProviderEvidence(store(admin), row.k, { kind: "committed", providerJobId: "job-lost", resultRef: "ref:audio-1", actualUsd: 0.04 }, () => new Date().toISOString());
    [row] = await rowsOf(sp.projectId);
    assert.deepEqual({ s: row.status, c: row.c, j: row.j }, { s: "COMMITTED", c: "0.0400", j: "job-lost" });
    const re = await guardPaidCall(store(admin), sp, m.hooks);
    assert.equal(re.reused, true); assert.equal(m.calls, 1);
    await invariants();
  });

  test(`[${n}] caída ANTES del envío al proveedor (fila SUBMITTED huérfana): ${n} reintentos → 0 envíos, fila intacta; marca explícita sólo tras la antigüedad, nunca vuelve a RESERVED`, async () => {
    const sp = spec(`crashpre${n}`);
    const never = mockProvider(() => new Promise(() => {})); // el proceso «muere» con la llamada abierta
    void guardPaidCall(store(admin), sp, never.hooks).catch(() => {});
    await sleep(150);
    let [row] = await rowsOf(sp.projectId);
    assert.equal(row.status, "SUBMITTED");
    const m = mockProvider(async () => ({ costUsd: 0.04 }));
    const rs = await race(n, sp, m);
    assert.equal(m.calls, 0);
    for (const nm of names(rs)) assert.equal(nm, "SubmissionInFlightError");
    assert.equal((await rowsOf(sp.projectId))[0].status, "SUBMITTED", "un envío legítimamente en vuelo no se reconcilia artificialmente");
    assert.equal(await flagStaleSubmission(store(admin), row.k, { minAgeMs: 15 * 60_000, now: () => new Date().toISOString() }), false);
    assert.equal(await flagStaleSubmission(store(admin), row.k, { minAgeMs: 15 * 60_000, now: () => new Date(Date.now() + 16 * 60_000).toISOString() }), true);
    [row] = await rowsOf(sp.projectId);
    assert.equal(row.status, "RECONCILIATION_REQUIRED");
    await assert.rejects(guardPaidCall(store(admin), sp, m.hooks), ReconciliationRequiredError);
    assert.equal(m.calls, 0, "el tiempo transcurrido nunca autoriza a repagar");
    assert.ok(!(await auditOf(row.k)).some((a) => a.o && a.o !== "RESERVED" && a.n === "RESERVED"));
    await invariants();
  });
}

test("ganador en vuelo marcado como huérfano a mitad de llamada → registra su job y liquida desde RECONCILIATION_REQUIRED (el pago no se pierde)", async () => {
  const sp = spec("stalewin");
  let release!: () => void;
  const m = mockProvider(() => new Promise((r) => { release = () => r({ costUsd: 0.04, jobId: "job-w" }); }));
  const p = guardPaidCall(store(admin), sp, m.hooks);
  await sleep(150);
  const [row] = await rowsOf(sp.projectId);
  assert.equal(await flagStaleSubmission(store(admin), row.k, { minAgeMs: 0, now: () => new Date(Date.now() + 60_000).toISOString() }), true);
  release();
  const out = await p;
  assert.equal(out.reused, false);
  const [fin] = await rowsOf(sp.projectId);
  assert.deepEqual({ s: fin.status, c: fin.c, j: fin.j }, { s: "COMMITTED", c: "0.0400", j: "job-w" });
  assert.deepEqual((await auditOf(row.k)).map((a) => a.n), ["RESERVED", "SUBMITTED", "RECONCILIATION_REQUIRED", "RECONCILIATION_REQUIRED", "COMMITTED"]);
  await invariants();
});

test("caída DESPUÉS de aceptar y antes de COMMIT (PROVIDER_JOB_RECORDED): el reintento reanuda el job sin reenviar; 1 sola liquidación", async () => {
  const sp = spec("crashpost");
  const s = store(admin);
  const crashing: LedgerStore = { ...s, submit: s.submit, update: async (k, e, p) => { if (p.status === "COMMITTED") throw new Error("process killed before COMMIT"); return s.update(k, e, p); } };
  const m = mockProvider(async () => ({ costUsd: 0.04, jobId: "job-async-1" }));
  await assert.rejects(guardPaidCall(crashing, sp, m.hooks));
  let [row] = await rowsOf(sp.projectId);
  assert.equal(row.status, "PROVIDER_JOB_RECORDED"); assert.equal(row.j, "job-async-1");
  let resumed = 0;
  const hooks = { ...m.hooks, resume: async (job: string) => { resumed++; return { result: `audio-${job}`, costUsd: 0.04, resultRef: `ref:${job}` }; } };
  const rs = await Promise.allSettled([guardPaidCall(store(admin), sp, hooks), guardPaidCall(store(admin), sp, hooks)]);
  assert.equal(m.calls, 1, "sin segundo envío");
  assert.ok(rs.some((r) => r.status === "fulfilled"));
  [row] = await rowsOf(sp.projectId);
  assert.equal(row.status, "COMMITTED"); assert.equal(row.c, "0.0400");
  assert.ok(resumed >= 1);
  await invariants();
});

for (const [label, err, expectStatus] of [
  ["429 rate_limited", new GenerativeProviderError("429", PROVIDER, "rate_limited" as never), "RECONCILIATION_REQUIRED"],
  ["timeout", new GenerativeProviderError("timeout", PROVIDER, "timeout"), "RECONCILIATION_REQUIRED"],
  ["5xx upstream_error", new GenerativeProviderError("502", PROVIDER, "upstream_error"), "RECONCILIATION_REQUIRED"],
  ["moderación (rechazo final, sin cobro)", new GenerativeProviderError("mod", PROVIDER, "moderation_rejected"), "REFUNDED"],
] as const) {
  test(`fallo del proveedor: ${label} → ${expectStatus}; 5 reintentos concurrentes → 0 envíos nuevos`, async () => {
    const sp = spec(label.replace(/\W+/g, ""));
    const m = mockProvider(async () => { throw err; });
    await assert.rejects(guardPaidCall(store(admin), sp, m.hooks));
    const [row] = await rowsOf(sp.projectId);
    assert.equal(row.status, expectStatus);
    if (expectStatus === "REFUNDED") assert.equal(row.c, "0.0000"); else assert.equal(row.c, null);
    await race(5, sp, m);
    assert.equal(m.calls, 1);
    await invariants();
  });
}

for (const n of [2, 5, 10]) {
  test(`[${n}] saldo insuficiente (RPC real) → 0 llamadas, fila RESERVED sin mutar`, async () => {
    await setBalance(0.01);
    try {
      const sp = spec(`poor${n}`);
      const m = mockProvider(async () => ({ costUsd: 0.04 }));
      const rs = await race(n, sp, m);
      assert.equal(m.calls, 0);
      for (const r of rs) assert.equal(r.status, "rejected");
      const [row] = await rowsOf(sp.projectId);
      assert.equal(row.status, "RESERVED");
      await invariants();
    } finally { await setBalance(100); }
  });
}

test("capacidad no verificable: saldo caducado (>5 min) → 0 llamadas; sin snapshot (UNKNOWN) → 0 llamadas; proveedor DOWN → 0 llamadas", async () => {
  for (const [tag, prep] of [
    // Contrato de producto (migración manual_balance_no_expiry): un saldo manual no caduca; uno leído del API caduca a los 5 min.
    ["stale", async () => { await admin.query(`delete from public.pi_capacity_snapshots where provider=$1`, [PROVIDER]); await setBalance(100, { reliability: "provider_api", ageMinutes: 60 }); }],
    ["unknown", () => admin.query(`delete from public.pi_capacity_snapshots where provider=$1`, [PROVIDER])],
    ["down", () => setBalance(100, { health: "DOWN" })],
  ] as const) {
    await prep();
    const sp = spec(tag);
    const m = mockProvider(async () => ({ costUsd: 0.04 }));
    const rs = await race(5, sp, m);
    assert.equal(m.calls, 0, tag);
    for (const r of rs) assert.equal(r.status, "rejected", tag);
    assert.equal((await rowsOf(sp.projectId))[0].status, "RESERVED", tag);
  }
  await setBalance(100);
  await invariants();
});

test("bloqueo por proyecto: con una operación en RECONCILIATION_REQUIRED el RPC real no admite otra del mismo proveedor (0 llamadas)", async () => {
  const sp = spec("projblock");
  const m = mockProvider(async () => { throw new Error("ETIMEDOUT"); });
  await assert.rejects(guardPaidCall(store(admin), sp, m.hooks));
  const other = { ...sp, shotId: "voice:s2", inputFingerprint: { text: "otro" } };
  const m2 = mockProvider(async () => ({ costUsd: 0.04 }));
  await assert.rejects(guardPaidCall(store(admin), other, m2.hooks));
  assert.equal(m2.calls, 0);
  await invariants();
});

test("fronteras numeric(12,4) en el ledger real: positivos diminutos nunca 0; inválidos rechazados antes de escribir", async () => {
  for (const [usd, stored] of [[0.00000001, "0.0001"], [0.00010000001, "0.0002"], [0.0001, "0.0001"], [12.50000001, "12.5001"]] as const) {
    const sp = spec(`b${stored}`, usd);
    const m = mockProvider(async () => ({ costUsd: usd }));
    await guardPaidCall(store(admin), sp, m.hooks);
    const [row] = await rowsOf(sp.projectId);
    assert.deepEqual({ r: row.r, c: row.c, s: row.status }, { r: stored, c: stored, s: "COMMITTED" });
  }
  for (const bad of [-1, -0.0001, Number.NaN, Infinity, 1e8]) {
    const sp = spec(`bad`, bad);
    const m = mockProvider(async () => ({ costUsd: 0.01 }));
    await assert.rejects(guardPaidCall(store(admin), sp, m.hooks));
    assert.equal(m.calls, 0);
    assert.equal((await rowsOf(sp.projectId)).length, 0);
  }
  await invariants();
});

test("egreso: ningún intento de salida no-loopback durante toda la suite", () => {
  assert.deepEqual(egress, []);
});

export { SubmissionInFlightError };
