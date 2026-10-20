/** Real PostgreSQL connections; synthetic ledger/supply core, real migrations. Never accepts a remote DB. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

async function main() {
const host = process.env.PGHOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Disposable localhost PostgreSQL only");
if (process.env.DATABASE_URL || process.env.PGSERVICE || process.env.PGOPTIONS) throw new Error("External connection overrides forbidden");
const connection = { host, port: Number(process.env.PGPORT ?? 5432), user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD, connectionTimeoutMillis: 5000, statement_timeout: 5000 };
const admin = new Client({ ...connection, database: "postgres" });
const database = `atomicvid_reel_budget_test_${randomUUID().replaceAll("-", "")}`;
const oldSql = await readFile("supabase/migrations/20261008120000_documentary_recovery_budget.sql", "utf8");
const newSql = await readFile("supabase/migrations/20261020150535_reel_provider_spend_cap.sql", "utf8");
let client: Client | undefined;
let checks = 0;
async function connect() { const c = new Client({ ...connection, database }); await c.connect(); return c; }
async function check(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`); }
await admin.connect();
try {
  for (const role of ["anon", "authenticated", "service_role"]) {
    if (!(await admin.query("select 1 from pg_roles where rolname=$1", [role])).rowCount)
      await admin.query(`create role ${role} nologin`);
  }
  await admin.query(`create database ${database}`);
  client = await connect();
  const db = client;
  await db.query(`
    create table public.video_requests(id uuid primary key, mode text not null);
    create table public.documentary_script_jobs(id uuid primary key, user_id uuid, status text);
    create table public.pi_supply_policies(provider text primary key);
    insert into public.pi_supply_policies values ('__global__');
    create table public.pi_paid_operations(idempotency_key text primary key, project_id text, provider text,
      method text default 'test', status text, reserved_usd numeric(12,4), committed_usd numeric(12,4),
      supply_reconciled boolean default false);
    -- Synthetic supply core deliberately admits everything that wins its CAS. This isolates the NEW
    -- total-cap wrapper; it is NOT a test of the full production supply schema, balances or providers.
    create function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
    language plpgsql as $$ begin
      perform 1 from public.pi_supply_policies where provider='__global__' for update;
      update public.pi_paid_operations set status='SUBMITTED' where idempotency_key=p_key and status='RESERVED';
      return jsonb_build_object('submitted',found,'reason','synthetic core');
    end $$;
  `);
  await db.query(oldSql);
  // RED: same schema/budget, prior admission function. The control is actually exercised, not ported to JS.
  await db.query(newSql.slice(0, newSql.indexOf("-- Keep the documentary")));
  const project = async (cap = 1.5) => {
    const id = randomUUID();
    await db.query("insert into video_requests values($1,'visual',$2)", [id, cap]); return id;
  };
  const operation = async (id: string, usd: number | string, status = "RESERVED", provider = "openai") => {
    const key = randomUUID();
    await db.query("insert into pi_paid_operations(idempotency_key,project_id,provider,status,reserved_usd) values($1,$2,$3,$4,$5)", [key,id,provider,status,usd]); return key;
  };
  const admit = async (key: string) => {
    const c = await connect();
    try { return (await c.query("select pi_submit_with_supply($1) as result", [key])).rows[0].result as { submitted: boolean; reason: string }; }
    finally { await c.end(); }
  };
  const race = async (n: number) => {
    const id = await project();
    const keys: string[] = [];
    for (let i = 0; i < n; i++) keys.push(await operation(id,.9,"RESERVED",i % 2 ? "anthropic" : "openai"));
    const results = await Promise.all(keys.map(admit)); return results.filter(r => r.submitted).length;
  };
  assert.equal(await race(10),10);
  console.log("RED verified: prior function admits USD 9.00 against a stored USD 1.50 cap");
  await db.query(newSql.slice(newSql.indexOf("-- Keep the documentary")));

  for (const n of [2,5,10]) await check(`${n} connections, different providers: one USD 0.90 admission`, async () => assert.equal(await race(n),1));
  await check("alternate UUID representations cannot bypass the shared cap", async () => {
    const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    await db.query("insert into video_requests values($1,'visual',1.5)",[id]);
    assert.equal((await admit(await operation(id,.9))).submitted,true);
    for (const alias of [id.toUpperCase(),`{${id}}`,id.replaceAll('-','')])
      assert.equal((await admit(await operation(alias,.9))).reason,"reel budget: project id noncanonical");
  });
  await check("committed and uncertain calls from earlier attempts count together", async () => {
    const id = await project();
    await operation(id,.8,"COMMITTED"); await operation(id,.4,"RECONCILIATION_REQUIRED","anthropic");
    assert.equal((await admit(await operation(id,.4))).reason,"reel budget exceeded");
    assert.equal((await admit(await operation(id,.3))).submitted,true); // Exact decimal boundary.
    assert.equal((await admit(await operation(id,.0001))).reason,"reel budget exceeded");
  });
  for (const status of ["SUBMITTED","PROVIDER_JOB_RECORDED","RECONCILIATION_REQUIRED","REFUNDED"])
    await check(`${status} keeps the uncertain amount protected`, async () => {
      const id = await project(); await operation(id,1.4,status);
      assert.equal((await admit(await operation(id,.2))).submitted,false);
    });
  await check("real settled cost and reconciled refunds; never-admitted reservations are not charges", async () => {
    const id = await project(); const paid = await operation(id,1,"COMMITTED");
    await db.query("update pi_paid_operations set committed_usd=.2 where idempotency_key=$1",[paid]);
    const refund = await operation(id,1,"REFUNDED");
    await db.query("update pi_paid_operations set supply_reconciled=true,committed_usd=0 where idempotency_key=$1",[refund]);
    await operation(id,3.25); // Capacity/reservation is NOT an admitted billable call.
    assert.equal((await admit(await operation(id,1.3))).submitted,true);
  });
  await check("ten duplicate admissions cannot call the provider twice", async () => {
    const key = await operation(await project(),.1);
    assert.equal((await Promise.all(Array.from({length:10},()=>admit(key)))).filter(r=>r.submitted).length,1);
  });
  for (const cost of ["0","-1","NaN"])
    await check(`unknown/invalid cost ${cost} is refused`, async () => {
      assert.equal((await admit(await operation(await project(),cost))).reason,"reel budget: cost unverified");
    });
  await check("fixed-precision SQL rejects infinite cost before admission", async () => {
    for (const cost of ["Infinity","-Infinity"])
      await assert.rejects(operation(await project(),cost));
  });
  await check("cap cannot be raised, lowered or removed", async () => {
    const id = await project();
    for (const cap of [2,1,null]) await assert.rejects(db.query("update video_requests set provider_spend_cap_usd=$2 where id=$1",[id,cap]),/immutable/);
    await assert.rejects(db.query("delete from video_requests where id=$1",[id]),/cannot be deleted/);
    await assert.rejects(db.query("update video_requests set id=$2 where id=$1",[id,randomUUID()]),/immutable/);
  });
  await check("uncapped legacy jobs and other modalities keep the original core", async () => {
    const id = randomUUID(); await db.query("insert into video_requests(id,mode) values($1,'avatar')",[id]);
    assert.equal((await admit(await operation(id,2))).submitted,true);
  });
  await check("documentary recovery cap is still enforced", async () => {
    const job = randomUUID(), owner = randomUUID(), id = `documentary:${owner}:test`;
    await db.query("insert into documentary_script_jobs values($1,$2,'failed')",[job,owner]);
    await db.query("insert into pi_recovery_budgets(project_id,job_id,owner_id,cap_usd,baseline_keys,authorization_ref) values($1,$2,$3,.1,'{}','synthetic test')",[id,job,owner]);
    assert.equal((await admit(await operation(id,.2))).reason,"recovery budget exceeded");
  });
  await check("lock order matches global-policy then request used by attempt reservation", async () => {
    const id = await project(), key = await operation(id,.1), a = await connect();
    try {
      await a.query("begin"); await a.query("select 1 from pi_supply_policies for update");
      const pending = admit(key);
      await a.query("select pg_sleep(.1)");
      await a.query("select 1 from video_requests where id=$1 for update",[id]);
      await a.query("commit"); assert.equal((await pending).submitted,true);
    } finally { await a.query("rollback"); await a.end(); }
  });
  await check("anon/authenticated cannot invoke the privileged admission function", async () => {
    for (const role of ["anon","authenticated"]) {
      await db.query(`set role ${role}`);
      try { await assert.rejects(db.query("select public.pi_submit_with_supply('none')"),/permission denied/); }
      finally { await db.query("reset role"); }
    }
  });
  console.log(`PostgreSQL: ${checks}/${checks} PASS. Synthetic ledger, no provider network calls.`);
} finally {
  await client?.end();
  await admin.query(`drop database if exists ${database} with (force)`);
  await admin.end();
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
