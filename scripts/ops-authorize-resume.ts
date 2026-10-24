/**
 * Owner-authorised durable resume authorization for e8048599 (PR #198 rule): CLOSE the ACTIVE recovery budget and
 * reopen it through pi_resume_recovery_budget(job, AUTHORIZATION_REF), which records the durable row (transaction id)
 * in pi_recovery_resume_authorizations. Cap (USD 0.60), baseline and paid responses are unchanged (immutable).
 * The owner's own limit (USD 0.20 total, 0.1589 remaining) stays enforced by ops-step. Requires CONFIRM=AUTHZ-RESUME-e8048599.
 */
async function main() {
  if (process.env.CONFIRM !== "AUTHZ-RESUME-e8048599") throw Error("confirmation missing");
  const ref = String(process.env.AUTHORIZATION_REF ?? "").trim(); if (ref.length < 8) throw Error("AUTHORIZATION_REF required");
  const JOB = "e8048599-cf92-45e8-95c8-f145cb9d3be2";
  const { Client } = await import("pg"); const pref = process.env.SUPABASE_PROJECT_REF;
  const c = new Client({ host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432), user: `postgres.${pref}`, password: process.env.SUPABASE_DB_PASSWORD, database: "postgres", ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("begin");
    const b = (await c.query("select project_id, status, cap_usd from public.pi_recovery_budgets where job_id = $1 for update", [JOB])).rows[0];
    if (!b) throw Error("budget not found");
    const usage = (await c.query("select public.pi_recovery_budget_usage($1) u", [b.project_id])).rows[0].u;
    if (Number(usage.pendingUsd) !== 0) throw Error("uncertain operations must be reconciled first");
    if (b.status === "ACTIVE") await c.query("update public.pi_recovery_budgets set status = 'CLOSED', closed_at = now() where project_id = $1", [b.project_id]);
    const r = (await c.query("select public.pi_resume_recovery_budget($1, $2) r", [JOB, ref])).rows[0].r;
    await c.query("commit");
    console.log("RESUME", JSON.stringify({ budgetBefore: b.status, capUsd: Number(b.cap_usd), result: r }));
  } catch (e) { await c.query("rollback").catch(() => {}); console.log("STOP", String(e).slice(0, 300)); process.exitCode = 1; }
  finally { await c.end(); }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
