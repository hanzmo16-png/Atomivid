/**
 * PREPARED, NOT RUN — owner-authorised opening of the Recraft (fal.ai) supply for e8048599.
 * Free (no generation, no provider call). What it changes in production, inside ONE transaction:
 *  1. pi_supply_policies('recraft'): enabled=true. Existing caps are KEPT (daily/monthly/concurrency/calls); unit_cost_usd
 *     is set to 1 only when unit='usd' (an envelope metered in USD with 0.04/unit exhausts on the 2nd image — R7).
 *  2. Optional: pi_capacity_snapshots row with reliability='manual_entry' (never expires) using the balance the OWNER
 *     read in the fal.ai dashboard (BALANCE_USD) at READ_AT (ISO time of the reading, not of this insert: every Recraft
 *     charge after READ_AT is then subtracted by pi_supply_state) + EVIDENCE text (who, where), appended to the policy
 *     evidence so the provenance is kept. Without it, FAL_ADMIN_KEY must be configured instead.
 * Requires CONFIRM=RECRAFT-ENABLE. DRY=1 prints the before/after without writing.
 */
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const dry = process.env.DRY === "1";
  if (!dry && process.env.CONFIRM !== "RECRAFT-ENABLE") throw Error("confirmation missing");
  const balance = process.env.BALANCE_USD ? Number(process.env.BALANCE_USD) : null;
  const evidence = String(process.env.EVIDENCE ?? "").trim();
  if (balance !== null && (!Number.isFinite(balance) || balance <= 0 || balance > 500)) throw Error("BALANCE_USD out of range");
  if (balance !== null && evidence.length < 12) throw Error("EVIDENCE required with BALANCE_USD (who read it, where, when)");
  const readAt = process.env.READ_AT ? new Date(process.env.READ_AT) : null;
  if (balance !== null && (!readAt || Number.isNaN(readAt.getTime()) || readAt.getTime() > Date.now() || Date.now() - readAt.getTime() > 48 * 3600e3))
    throw Error("READ_AT required with BALANCE_USD: ISO time of the dashboard reading, not in the future, at most 48 h old");
  const { connectResolved } = await import("./lib/supabase-db");
  const { client: c } = await connectResolved();
  try {
    await c.query("begin");
    const before = (await c.query("select provider, enabled, unit, unit_cost_usd, daily_cap_usd, monthly_cap_usd, max_concurrent, max_daily_calls from public.pi_supply_policies where provider = 'recraft' for update")).rows[0];
    if (!before) throw Error("recraft policy row missing");
    const unitCost = before.unit === "usd" ? 1 : Number(before.unit_cost_usd);
    const note = `${new Date().toISOString()}: owner-authorised e8048599 cinematic recovery` +
      (balance !== null ? `; fal.ai balance USD ${balance.toFixed(2)} read ${readAt!.toISOString()} — ${evidence.slice(0, 300)}` : "");
    await c.query("update public.pi_supply_policies set enabled = true, unit_cost_usd = $1, evidence = trim(both from coalesce(evidence, '') || E'\\n' || $2) where provider = 'recraft'",
      [unitCost, note]);
    if (balance !== null) {
      await c.query("insert into public.pi_capacity_snapshots(provider, unit, available, reserved, pending, health, reliability, status, checked_at) values ('recraft', $1, $2, 0, 0, 'OK', 'manual_entry', $3, $4)",
        [before.unit, before.unit === "usd" ? balance : balance / Number(before.unit_cost_usd), balance >= 2 ? "GREEN" : "YELLOW", readAt!.toISOString()]);
    }
    const state = (await c.query("select public.pi_supply_state('recraft') s")).rows[0]?.s ?? null;
    const after = (await c.query("select enabled, unit, unit_cost_usd, daily_cap_usd, monthly_cap_usd, max_concurrent, max_daily_calls from public.pi_supply_policies where provider = 'recraft'")).rows[0];
    log("RECRAFT", { dry, before, after, manualBalance: balance, readAt: readAt?.toISOString() ?? null, evidence: balance !== null ? evidence.slice(0, 120) : null, state });
    await c.query(dry ? "rollback" : "commit");
    log("END", { committed: !dry });
  } catch (e) { await c.query("rollback").catch(() => {}); console.log("STOP", String(e).slice(0, 300)); process.exitCode = 1; }
  finally { await c.end(); }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
