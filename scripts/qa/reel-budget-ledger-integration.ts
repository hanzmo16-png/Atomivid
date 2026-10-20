/** Disposable localhost PostgreSQL; actual ledger + supply functions, no provider traffic. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

async function main() {
  const host = process.env.PGHOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Disposable localhost PostgreSQL only");
  if (process.env.DATABASE_URL || process.env.PGSERVICE || process.env.PGOPTIONS) throw new Error("External connection overrides forbidden");
  const connection = { host, port: Number(process.env.PGPORT ?? 5432), user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD, connectionTimeoutMillis: 5000, statement_timeout: 10000 };
  const database = `atomicvid_reel_integration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ ...connection, database: "postgres" });
  let db: Client | undefined;
  let checks = 0;
  async function connect() { const c = new Client({ ...connection, database }); await c.connect(); return c; }
  async function check(name: string, test: () => Promise<void>) { await test(); checks++; console.log(`PASS ${name}`); }
  await admin.connect();
  try {
    for (const role of ["anon", "authenticated", "service_role"]) {
      if (!(await admin.query("select 1 from pg_roles where rolname=$1", [role])).rowCount)
        await admin.query(`create role ${role} nologin`);
    }
    await admin.query(`create database ${database}`);
    db = await connect();
    const sql = db;
    // Only application-owned parent tables are minimal fixtures. All financial tables/functions
    // below come from byte-verified historical DDL or the unchanged repository migrations.
    await sql.query(`create table video_requests(id uuid primary key,user_id uuid,mode text not null,
      status text default 'processing',render_attempts integer default 1,progress_stage text,error_message text);
      create table documentary_script_jobs(id uuid primary key,user_id uuid,status text);
      create table podcast_episodes(id uuid primary key,status text,run_token uuid,video_status text,video_run_token uuid);`);
    const base = await readFile("scripts/qa/fixtures/0023-production-intelligence.sql", "utf8");
    assert.equal(createHash("sha256").update(base).digest("hex"), "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131");
    await sql.query(base);
    const migrations = [
      "20261005143935_provider_supply_controls.sql",
      "20261005145807_provider_supply_settlement_clock.sql",
      "20261005150229_provider_supply_job_reservations.sql",
      "20261005152850_provider_supply_worker_slots.sql",
      "20261006021611_manual_balance_freshness_30_minutes.sql",
      "20261006052212_completed_visual_review_concurrency.sql",
      "20261006135845_manual_balance_no_expiry.sql",
      "20261008120000_documentary_recovery_budget.sql",
      "20261013173826_failed_script_concurrency_slot.sql",
      "20261014183400_finished_podcast_image_slot.sql",
    ];
    for (const file of migrations) {
      await sql.query("begin");
      try { await sql.query(await readFile(`supabase/migrations/${file}`, "utf8")); await sql.query("commit"); }
      catch (error) { await sql.query("rollback"); throw new Error(`Migration ${file} failed`, { cause: error }); }
    }
    console.log(`Actual ledger DDL + ${migrations.length} unchanged supply migrations loaded`);
    // Deliberately synthetic funded balances. These are NOT observations of production accounts.
    await sql.query(`update pi_supply_policies set enabled=true,baseline=100,unit_cost_usd=1,
      daily_forecast=1,daily_cap_usd=100000,monthly_cap_usd=100000,max_concurrent=1000,
      max_daily_calls=10000,evidence='SYNTHETIC disposable integration test';
      insert into pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at)
      select provider,unit,100000,'OK','provider_api','GREEN',clock_timestamp() from pi_supply_policies where provider<>'__global__';`);
    const newSql = await readFile("supabase/migrations/20261020150535_reel_provider_spend_cap.sql", "utf8");
    const split = newSql.indexOf("-- Keep the documentary");
    assert.ok(split > 0);
    await sql.query(newSql.slice(0, split));
    const project = async (cap: number | null = 1.5, mode = "visual") => {
      const id = randomUUID();
      await sql.query("insert into video_requests(id,user_id,mode,provider_spend_cap_usd) values($1,$2,$3,$4)", [id,randomUUID(),mode,cap]);
      return id;
    };
    const operation = async (id: string, usd: number | string, provider = "openai", status = "RESERVED", committed: number | null = null, reconciled = false) => {
      const key = randomUUID();
      await sql.query(`insert into pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,
        attempt_kind,reserved_usd,status,committed_usd,supply_reconciled) values($1,$2,'test',$3,'fixture','test','initial',$4,$5,$6,$7)`,
      [key,id,provider,usd,status,committed,reconciled]); return key;
    };
    const admit = async (key: string) => {
      const c = await connect();
      try { await c.query("set role service_role"); return (await c.query("select public.pi_submit_with_supply($1) as result", [key])).rows[0].result as { submitted: boolean; reason: string }; }
      finally { await c.end(); }
    };
    const race = async (n: number) => {
      const id = await project();
      const keys = await Promise.all(Array.from({length:n}, (_, i) => operation(id,.9,i % 2 ? "elevenlabs" : "openai")));
      return { id, results: await Promise.all(keys.map(admit)) };
    };
    const red = await race(10);
    assert.equal(red.results.filter(r=>r.submitted).length,10);
    console.log("RED actual supply core: USD 9 admitted despite stored USD 1.50 cap");
    await sql.query(newSql.slice(split));
    for (const n of [2,5,10]) await check(`${n} real connections: total cap allows one call across providers`, async () => {
      const {id,results} = await race(n);
      assert.equal(results.filter(r=>r.submitted).length,1);
      assert.equal(results.filter(r=>r.reason==="reel budget exceeded").length,n-1);
      assert.equal((await sql.query("select sum(reserved_usd)::text as held from pi_paid_operations where project_id=$1 and status='SUBMITTED'",[id])).rows[0].held,"0.9000");
    });
    await check("exact boundary includes committed and earlier uncertain spend", async () => {
      const id = await project();
      await operation(id,.8,"openai","COMMITTED",.8);
      await operation(id,.4,"openai","RECONCILIATION_REQUIRED");
      assert.equal((await admit(await operation(id,.4,"elevenlabs"))).reason,"reel budget exceeded");
      assert.equal((await admit(await operation(id,.3,"elevenlabs"))).submitted,true);
      assert.equal((await admit(await operation(id,.0001,"elevenlabs"))).reason,"reel budget exceeded");
    });
    for (const status of ["SUBMITTED","PROVIDER_JOB_RECORDED","RECONCILIATION_REQUIRED","REFUNDED"])
      await check(`actual ledger keeps ${status} exposure inside cap`, async () => {
        const id = await project(); await operation(id,1.4,"openai",status);
        assert.equal((await admit(await operation(id,.2,"elevenlabs"))).reason,"reel budget exceeded");
      });
    await check("settled actual amount, reconciled refunds and unused reservations are counted correctly", async () => {
      const id = await project(); await operation(id,1,"openai","COMMITTED",.2);
      await operation(id,1,"openai","REFUNDED",0,true); await operation(id,3.25);
      assert.equal((await admit(await operation(id,1.3,"elevenlabs"))).submitted,true);
    });
    await check("10 duplicate admissions produce one submission and preserve ledger identity", async () => {
      const id = await project(), key = await operation(id,.1);
      assert.equal((await Promise.all(Array.from({length:10},()=>admit(key)))).filter(r=>r.submitted).length,1);
      assert.equal((await sql.query("select count(*)::int as n from pi_paid_operations where project_id=$1",[id])).rows[0].n,1);
      await assert.rejects(sql.query("update pi_paid_operations set status='RESERVED' where idempotency_key=$1",[key]),/cannot move back/i);
    });
    await check("invalid numeric costs fail before supply admission", async () => {
      for (const cost of ["-1","NaN","Infinity","-Infinity"]) await assert.rejects(operation(await project(),cost));
      assert.equal((await admit(await operation(await project(),0))).reason,"reel budget: cost unverified");
    });
    const reserve = async (id: string, usd: number) => (await sql.query("select pi_reserve_job_supply($1,1,$2::jsonb) as result",[id,JSON.stringify([{provider:"openai",unit:"usd",usd}])])).rows[0].result;
    await check("USD 3.25 job envelope cannot override USD 1.50 cap or consume twice", async () => {
      const id = await project(); assert.equal((await reserve(id,3.25)).reserved,true);
      assert.equal((await admit(await operation(id,.9))).submitted,true);
      assert.equal((await admit(await operation(id,.9))).reason,"reel budget exceeded");
      const r = (await sql.query("select consumed_usd::text as used from pi_supply_job_reservations where project_id=$1",[id])).rows[0];
      assert.equal(r.used,"0.9");
      await sql.query("select pi_release_job_supply($1,1)",[id]);
      assert.equal((await admit(await operation(id,.7))).reason,"reel budget exceeded");
    });
    await check("existing envelope exhaustion still blocks a call that fits the Reel cap", async () => {
      const id = await project(); assert.equal((await reserve(id,.5)).reserved,true);
      assert.equal((await admit(await operation(id,.6))).reason,"job envelope exhausted");
    });
    await check("existing funded global switch remains fail-closed", async () => {
      await sql.query("update pi_supply_policies set enabled=false where provider='__global__'");
      try { assert.equal((await admit(await operation(await project(),.1))).reason,"funded global budget unconfigured"); }
      finally { await sql.query("update pi_supply_policies set enabled=true where provider='__global__'"); }
    });
    await check("existing provider health and unknown balances still block", async () => {
      await sql.query("update pi_capacity_snapshots set health='DOWN' where provider='openai'");
      try { assert.equal((await admit(await operation(await project(),.1))).submitted,false); }
      finally { await sql.query("update pi_capacity_snapshots set health='OK' where provider='openai'"); }
      await sql.query("update pi_capacity_snapshots set reliability='none' where provider='openai'");
      try { assert.equal((await admit(await operation(await project(),.1))).reason,"balance unverified or stale"); }
      finally { await sql.query("update pi_capacity_snapshots set reliability='provider_api' where provider='openai'"); }
    });
    await check("same-provider uncertain consumption still requires reconciliation", async () => {
      const id = await project(); await operation(id,.1,"openai","RECONCILIATION_REQUIRED");
      assert.equal((await admit(await operation(id,.1))).reason,"previous consumption requires reconciliation");
    });
    await check("real supply reservation and admission share lock order without a deadlock", async () => {
      const id = await project(), key = await operation(id,.1), holder = await connect();
      try {
        await holder.query("begin"); await holder.query("select 1 from pi_supply_policies where provider='__global__' for update");
        const pending = admit(key);
        await holder.query("select pg_sleep(.1)");
        const r = (await holder.query("select pi_reserve_job_supply($1,1,$2::jsonb) as result",[id,JSON.stringify([{provider:"openai",unit:"usd",usd:.5}])])).rows[0].result;
        assert.equal(r.reserved,true); await holder.query("commit"); assert.equal((await pending).submitted,true);
      } finally { await holder.query("rollback"); await holder.end(); }
    });
    await check("cap remains immutable while normal worker status updates are permitted", async () => {
      const id = await project();
      for (const cap of [2,1,null]) await assert.rejects(sql.query("update video_requests set provider_spend_cap_usd=$2 where id=$1",[id,cap]),/immutable/);
      await assert.rejects(sql.query("delete from video_requests where id=$1",[id]),/cannot be deleted/);
      await sql.query("update video_requests set status='completed' where id=$1",[id]);
    });
    await check("actual final ledger entries cannot be rewritten or deleted", async () => {
      const key = await operation(await project(),.2,"openai","COMMITTED",.1);
      await assert.rejects(sql.query("update pi_paid_operations set committed_usd=0 where idempotency_key=$1",[key]),/final|immutable/i);
      await assert.rejects(sql.query("delete from pi_paid_operations where idempotency_key=$1",[key]),/delete|append/i);
    });
    await check("legacy uncapped requests and documentary budget retain their behavior", async () => {
      assert.equal((await admit(await operation(await project(null,"avatar"),2))).submitted,true);
      const owner = randomUUID(), job = randomUUID(), id = `documentary:${owner}:integration`;
      await sql.query("insert into documentary_script_jobs values($1,$2,'failed')",[job,owner]);
      await sql.query("insert into pi_recovery_budgets(project_id,job_id,owner_id,cap_usd,baseline_keys,authorization_ref) values($1,$2,$3,.1,'{}','synthetic')",[id,job,owner]);
      assert.equal((await admit(await operation(id,.2))).reason,"recovery budget exceeded");
    });
    await check("client roles cannot execute wrapper or bypass through original supply core", async () => {
      for (const role of ["anon","authenticated","service_role"]) {
        await sql.query(`set role ${role}`);
        try {
          await assert.rejects(sql.query("select pi_submit_with_supply_core('missing')"),/permission denied/);
          if (role !== "service_role") await assert.rejects(sql.query("select pi_submit_with_supply('missing')"),/permission denied/);
        } finally { await sql.query("reset role"); }
      }
    });
    console.log(`Actual ledger/supply integration: ${checks}/${checks} PASS; zero provider calls. Application parent tables and balances are fixtures.`);
  } finally {
    await db?.end();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
