/**
 * Puerta de la migración 20261028100000 (pi_supply_spend al costo real). Modos:
 * - pre: (solo lectura) exige cuerpo vivo == rollback (definición de O8) y la migración sin registrar;
 * - post: (solo lectura) exige cuerpo vivo == propuesta, registro presente, permisos de ejecución sin cambios y
 *   pi_supply_spend('anthropic', mes) == suma recalculada con la fórmula nueva;
 * - rollback: en UNA transacción, solo si el cuerpo vivo es la propuesta: aplica el rollback auditado y quita el registro;
 *   después exige cuerpo vivo == rollback.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connectResolved } from "../../lib/supabase-db";

const NAME = "20261028100000_pi_supply_spend_committed.sql";
const norm = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\s*([(),=<>'])\s*/g, "$1").trim().toLowerCase();
const h = (s: string) => createHash("sha256").update(norm(s)).digest("hex").slice(0, 16);
const body = (src: string) => /\$\$([\s\S]*?)\$\$/.exec(src)?.[1] ?? "";
const month = "date_trunc('month', now() at time zone 'America/Cancun') at time zone 'America/Cancun'";

async function main() {
  const mode = process.argv[2];
  if (!["pre", "post", "rollback"].includes(mode)) throw new Error("modo: pre | post | rollback");
  const rollbackSql = await readFile(`supabase/proposals/${NAME.replace(".sql", ".rollback.sql")}`, "utf8");
  const proposalSql = await readFile(`supabase/proposals/${NAME}`, "utf8");
  const want = { rollback: h(body(rollbackSql)), proposal: h(body(proposalSql)) };
  const { client } = await connectResolved();
  const state = async () => {
    const { rows: [fn] } = await client.query("select p.prosrc, p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_supply_spend'");
    const { rowCount } = await client.query("select 1 from public._migrations_applied where name=$1", [NAME]);
    return { live: fn ? h(fn.prosrc) : null, acl: fn?.acl ?? null, registered: (rowCount ?? 0) > 0 };
  };
  try {
    if (mode === "rollback") {
      await client.query("begin");
      try {
        const s = await state();
        if (s.live !== want.proposal) throw new Error(`rollback negado: el cuerpo vivo (${s.live}) no es la propuesta (${want.proposal})`);
        await client.query(rollbackSql);
        await client.query("delete from public._migrations_applied where name=$1", [NAME]);
        await client.query("commit");
      } catch (e) { await client.query("rollback"); throw e; }
      const s = await state();
      console.log("ROLLBACK", JSON.stringify({ ...s, want }));
      if (s.live !== want.rollback || s.registered) throw new Error("tras el rollback el estado no es el previo");
      return;
    }
    await client.query("begin transaction read only");
    try {
      const s = await state();
      const out: Record<string, unknown> = { mode, ...s, want };
      let ok = false;
      if (mode === "pre") ok = s.live === want.rollback && !s.registered;
      else {
        const { rows: [v] } = await client.query(`select public.pi_supply_spend('anthropic', ${month})::numeric(12,4) fn,
          (select coalesce(sum(case when status='COMMITTED' then coalesce(committed_usd,reserved_usd) else greatest(reserved_usd,coalesce(committed_usd,0)) end),0) from public.pi_paid_operations where provider='anthropic' and method<>'capacity_hold' and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') or (created_at>=${month} and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled)))))
          + coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations where provider='anthropic' and status='OPEN'),0)
          + coalesce((select sum(case when s.state='settled' then coalesce(s.actual_usd,s.reserved_usd) else s.reserved_usd end) from public.podcast_studio_operations s where s.provider='anthropic' and (s.state in ('reserved','uncertain') or (s.state='settled' and s.created_at>=${month}))),0) expected`);
        const expected = Number(v.expected).toFixed(4);
        out.anthropicMonth = { fn: v.fn, expected };
        out.aclExpected = process.env.ACL_PRE ?? null;
        ok = s.live === want.proposal && s.registered && v.fn === expected && (!process.env.ACL_PRE || process.env.ACL_PRE === s.acl);
      }
      console.log("GATE", JSON.stringify({ ...out, ok }));
      if (mode === "pre" && process.env.GITHUB_ENV) await import("node:fs").then((fs) => fs.appendFileSync(process.env.GITHUB_ENV!, `ACL_PRE=${s.acl ?? ""}\n`));
      if (!ok) process.exitCode = 2;
    } finally { await client.query("rollback"); }
  } finally { await client.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
