/**
 * Lectura de Postgres en SOLO LECTURA (transacción read only) antes de aplicar la migración 20261028100000:
 * - definición actual de pi_supply_spend (hash normalizado) frente a la original del repositorio;
 * - si la migración ya figura en public._migrations_applied;
 * - gasto de Anthropic del día y del mes con la fórmula actual y con la nueva, calculadas en SQL sin crear nada.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connectResolved } from "../../lib/supabase-db";

const norm = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\s*([(),=<>'])\s*/g, "$1").trim().toLowerCase();
const h = (s: string) => createHash("sha256").update(norm(s)).digest("hex").slice(0, 16);
async function main() {
  const { client } = await connectResolved();
  await client.query("begin transaction read only");
  try {
    const { rows: [fn] } = await client.query("select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_supply_spend'");
    const original = await readFile("supabase/proposals/20261028100000_pi_supply_spend_committed.rollback.sql", "utf8").catch(() => "");
    const body = (src: string) => (/\$\$([\s\S]*?)\$\$/.exec(src)?.[1] ?? "");
    console.log("FN", JSON.stringify({ present: !!fn, liveHash: fn ? h(fn.prosrc) : null, originalHash: original ? h(body(original)) : null, equalsOriginal: fn && original ? h(fn.prosrc) === h(body(original)) : null }));
    const { rows: mig } = await client.query("select name from public._migrations_applied where name like '20261028%' or name like '%pi_supply_spend%'").catch(() => ({ rows: [{ name: "registry-unavailable" }] }));
    console.log("REGISTRY", JSON.stringify(mig));
    const day = "date_trunc('day', now() at time zone 'America/Cancun') at time zone 'America/Cancun'";
    const month = "date_trunc('month', now() at time zone 'America/Cancun') at time zone 'America/Cancun'";
    const expr = (newer: boolean, start: string) => `select coalesce(sum(${newer ? "case when status='COMMITTED' then coalesce(committed_usd,reserved_usd) else greatest(reserved_usd,coalesce(committed_usd,0)) end" : "greatest(reserved_usd,coalesce(committed_usd,0))"}),0)::numeric(12,4) v from public.pi_paid_operations where provider='anthropic' and method<>'capacity_hold' and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') or (created_at>=${start} and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))`;
    const out: Record<string, string> = {};
    for (const [k, newer, start] of [["dayNow", false, day], ["dayNew", true, day], ["monthNow", false, month], ["monthNew", true, month]] as const) out[k] = (await client.query(expr(newer, start))).rows[0].v;
    console.log("ANTHROPIC_SPEND", JSON.stringify(out));
    const { rows: held } = await client.query("select status, count(*)::int n, sum(reserved_usd)::numeric(12,4) reserved from public.pi_paid_operations where provider='anthropic' and status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') group by status");
    console.log("ANTHROPIC_OPEN", JSON.stringify(held));
  } finally { await client.query("rollback"); await client.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
