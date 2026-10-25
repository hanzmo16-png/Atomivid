/**
 * T-20261025-0112-chatgpt-02 — Disposable localhost PostgreSQL with the actual ledger DDL + supply migrations.
 * The REAL app path (reconcileWithProviderEvidence + supabaseLedgerStore) writes through a minimal PostgREST
 * shim (only the select/eq/maybeSingle and update/eq/select chains the store uses) into pi_paid_operations;
 * pi_supply_spend is the real SQL function. No provider traffic, USD 0.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { reconcileWithProviderEvidence } from "@/lib/production-intelligence/ledger";

type Row = Record<string, unknown>;
function postgrestShim(sql: Client) {
  const ident = (k: string) => { assert.match(k, /^[a-z_]+$/); return k; };
  const where = (f: Array<[string, unknown]>, off: number) => f.map(([k], i) => `${ident(k)}=$${i + 1 + off}`).join(" and ");
  return {
    from(table: string) {
      assert.equal(table, "pi_paid_operations");
      const filters: Array<[string, unknown]> = [];
      const chain = {
        select() { return chain; },
        eq(k: string, v: unknown) { filters.push([k, v]); return chain; },
        async maybeSingle() {
          try {
            const r = await sql.query(`select * from public.pi_paid_operations where ${where(filters, 0)}`, filters.map(([, v]) => v));
            return { data: r.rows[0] ?? null, error: null };
          } catch (e) { return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } }; }
        },
        async insert(row: Row) {
          const keys = Object.keys(row).map(ident);
          try { await sql.query(`insert into public.pi_paid_operations(${keys}) values(${keys.map((_, i) => `$${i + 1}`)})`, Object.values(row)); return { error: null }; }
          catch (e) { return { error: { code: (e as { code?: string }).code, message: (e as Error).message } }; }
        },
        update(patch: Row) {
          const keys = Object.keys(patch).map(ident);
          const upd = {
            eq(k: string, v: unknown) { filters.push([k, v]); return upd; },
            async select() {
              try {
                const r = await sql.query(`update public.pi_paid_operations set ${keys.map((k, i) => `${k}=$${i + 1}`)} where ${where(filters, keys.length)} returning idempotency_key`,
                  [...Object.values(patch), ...filters.map(([, v]) => v)]);
                return { data: r.rows, error: null };
              } catch (e) { return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } }; }
            },
          };
          return upd;
        },
      };
      return chain;
    },
  } as never;
}

async function main() {
  const host = process.env.PGHOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Disposable localhost PostgreSQL only");
  if (process.env.DATABASE_URL || process.env.PGSERVICE || process.env.PGOPTIONS) throw new Error("External connection overrides forbidden");
  const connection = { host, port: Number(process.env.PGPORT ?? 5432), user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD, connectionTimeoutMillis: 5000, statement_timeout: 10000 };
  const database = `atomicvid_reconcile_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ ...connection, database: "postgres" });
  let sql: Client | undefined; let other: Client | undefined;
  let checks = 0;
  async function check(name: string, t: () => Promise<void>) { await t(); checks++; console.log(`PASS ${name}`); }
  await admin.connect();
  try {
    for (const role of ["anon", "authenticated", "service_role"])
      if (!(await admin.query("select 1 from pg_roles where rolname=$1", [role])).rowCount) await admin.query(`create role ${role} nologin`);
    await admin.query(`create database ${database}`);
    sql = new Client({ ...connection, database }); await sql.connect();
    other = new Client({ ...connection, database }); await other.connect();
    await sql.query(`create table video_requests(id uuid primary key,user_id uuid,mode text not null,
      status text default 'processing',render_attempts integer default 1,progress_stage text,error_message text);
      create table documentary_script_jobs(id uuid primary key,user_id uuid,status text);
      create table podcast_episodes(id uuid primary key,status text,run_token uuid,video_status text,video_run_token uuid);`);
    const base = await readFile("scripts/qa/fixtures/0023-production-intelligence.sql", "utf8");
    assert.equal(createHash("sha256").update(base).digest("hex"), "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131");
    await sql.query(base);
    for (const file of ["20261005143935_provider_supply_controls.sql", "20261005145807_provider_supply_settlement_clock.sql",
      "20261005150229_provider_supply_job_reservations.sql"]) await sql.query(await readFile(`supabase/migrations/${file}`, "utf8"));
    const PROVIDER = "heygen";
    const spend = async () => Number((await sql!.query("select public.pi_supply_spend($1, now() - interval '1 day') v", [PROVIDER])).rows[0].v);
    const store = supabaseLedgerStore(postgrestShim(sql));
    const at = () => new Date().toISOString();
    const seed = async (status: string, usd = 6.58) => {
      const key = `op_${randomUUID()}`;
      await sql!.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
        values($1,'podcast-synthetic','s',$2,'m','video','initial',$3,$4)`, [key, PROVIDER, usd, status]);
      return key;
    };
    const row = async (key: string) => (await sql!.query("select status,committed_usd::text c,supply_reconciled sr,result_ref from public.pi_paid_operations where idempotency_key=$1", [key])).rows[0];

    await check("RR not_charged via the real store: REFUNDED, committed 0, supply_reconciled=true; pi_supply_spend drops by the full reservation", async () => {
      const key = await seed("RECONCILIATION_REQUIRED");
      const s0 = await spend();
      await reconcileWithProviderEvidence(store, key, { kind: "not_charged", proof: "heygen:video-list:none" }, at);
      assert.deepEqual(await row(key), { status: "REFUNDED", c: "0.0000", sr: true, result_ref: "reconciled:not_charged:heygen:video-list:none" });
      assert.equal(Math.round((s0 - (await spend())) * 1e4) / 1e4, 6.58);
    });
    await check("control: the same transition WITHOUT supply_reconciled (pre-fix runtime) keeps counting the reservation", async () => {
      const key = await seed("RECONCILIATION_REQUIRED");
      const s0 = await spend();
      await sql!.query("update public.pi_paid_operations set status='REFUNDED',committed_usd=0 where idempotency_key=$1 and status='RECONCILIATION_REQUIRED'", [key]);
      assert.equal(await spend(), s0, "REFUNDED + supply_reconciled=false is still spend (the defect)");
    });
    await check("SUBMITTED not_charged also reconciles and frees the spend", async () => {
      const key = await seed("SUBMITTED", 0.5);
      const s0 = await spend();
      await reconcileWithProviderEvidence(store, key, { kind: "not_charged", proof: "p" }, at);
      assert.equal((await row(key)).sr, true);
      assert.equal(Math.round((s0 - (await spend())) * 1e4) / 1e4, 0.5);
    });
    await check("replays (identical and contradictory) after REFUNDED are refused; row and spend unchanged", async () => {
      const key = await seed("RECONCILIATION_REQUIRED");
      await reconcileWithProviderEvidence(store, key, { kind: "not_charged", proof: "p" }, at);
      const r0 = await row(key); const s0 = await spend();
      await assert.rejects(reconcileWithProviderEvidence(store, key, { kind: "not_charged", proof: "p" }, at), /not reconcilable/);
      await assert.rejects(reconcileWithProviderEvidence(store, key, { kind: "committed", providerJobId: "j", resultRef: "r", actualUsd: 6.58 }, at), /not reconcilable/);
      await assert.rejects(sql!.query("update public.pi_paid_operations set supply_reconciled=false where idempotency_key=$1", [key]), /final/);
      assert.deepEqual(await row(key), r0); assert.equal(await spend(), s0);
    });
    await check("two operators on two connections: exactly one wins the CAS; the loser is refused, nothing overwritten", async () => {
      const key = await seed("RECONCILIATION_REQUIRED");
      const s2 = supabaseLedgerStore(postgrestShim(other!));
      const rs = await Promise.allSettled([
        reconcileWithProviderEvidence(store, key, { kind: "not_charged", proof: "a" }, at),
        reconcileWithProviderEvidence(s2, key, { kind: "committed", providerJobId: "j", resultRef: "r", actualUsd: 6.58 }, at),
      ]);
      assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
      const r = await row(key);
      assert.ok(r.status === "REFUNDED" ? r.sr === true : r.status === "COMMITTED" && r.sr === false, JSON.stringify(r));
    });
    await check("stale CAS: the row is committed between read and write → refused, supply_reconciled stays false", async () => {
      const key = await seed("RECONCILIATION_REQUIRED");
      const racing = supabaseLedgerStore(postgrestShim(sql!));
      const get = racing.get.bind(racing);
      racing.get = async (k) => { const r = await get(k); await other!.query("update public.pi_paid_operations set status='COMMITTED',committed_usd=6.58 where idempotency_key=$1", [k]); return r; };
      await assert.rejects(reconcileWithProviderEvidence(racing, key, { kind: "not_charged", proof: "p" }, at), /row changed/);
      assert.deepEqual({ s: (await row(key)).status, sr: (await row(key)).sr }, { s: "COMMITTED", sr: false });
    });
    await check("empty proof, RESERVED and a real charge never set supply_reconciled", async () => {
      const rr = await seed("RECONCILIATION_REQUIRED");
      await assert.rejects(reconcileWithProviderEvidence(store, rr, { kind: "not_charged", proof: "  " }, at), /proof/);
      assert.deepEqual({ s: (await row(rr)).status, sr: (await row(rr)).sr }, { s: "RECONCILIATION_REQUIRED", sr: false });
      await reconcileWithProviderEvidence(store, rr, { kind: "committed", providerJobId: "j", resultRef: "r", actualUsd: 6.58 }, at);
      assert.deepEqual({ s: (await row(rr)).status, c: (await row(rr)).c, sr: (await row(rr)).sr }, { s: "COMMITTED", c: "6.5800", sr: false });
      const res = await seed("RESERVED");
      const s0 = await spend();
      await assert.rejects(reconcileWithProviderEvidence(store, res, { kind: "not_charged", proof: "p" }, at), /not reconcilable/);
      assert.deepEqual({ s: (await row(res)).status, sr: (await row(res)).sr }, { s: "RESERVED", sr: false }); assert.equal(await spend(), s0);
    });
    console.log(`Reconcile not_charged (real store + real pi_supply_spend): ${checks}/${checks} PASS; zero provider calls.`);
  } finally {
    await sql?.end(); await other?.end();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
