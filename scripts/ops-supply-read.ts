/** Read-only: latest capacity snapshot per provider (no provider calls, no writes). */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  for (const p of ["elevenlabs", "heygen", "recraft", "anthropic"]) {
    const { data, error } = await db.from("pi_capacity_snapshots").select("provider,unit,available,health,reliability,status,checked_at").eq("provider", p).order("checked_at", { ascending: false }).limit(1);
    console.log("SNAP", JSON.stringify({ p, row: data?.[0] ?? null, error: error?.message ?? null }));
  }
  const { data: pol } = await db.from("pi_supply_policies").select("provider,enabled,unit,baseline,daily_cap_usd,monthly_cap_usd").order("provider");
  console.log("POLICY", JSON.stringify(pol));
  for (const t of ["podcast_studio_episodes", "podcast_studio_operations"]) { const { error } = await db.from(t).select("id", { head: true, count: "exact" }).limit(1); console.log("PODCAST", JSON.stringify({ table: t, exists: !error, error: error?.code ?? null })); }
}
main().catch((e) => { console.log("STOP", String(e).slice(0, 300)); });
