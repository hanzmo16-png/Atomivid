/** Read-only: real per-call cost of past OpenAI image generations from the ledger. */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.from("pi_paid_operations").select("model,method,status,reserved_usd,committed_usd,created_at").eq("provider", "openai").order("created_at", { ascending: false }).limit(200);
  if (error) throw Error("read");
  const groups: Record<string, number[]> = {};
  for (const o of data ?? []) if (o.status === "COMMITTED") (groups[`${o.model}|${o.method}`] ??= []).push(Number(o.committed_usd));
  for (const [k, v] of Object.entries(groups)) {
    const s = [...v].sort((a, b) => a - b);
    console.log("OPENAI", JSON.stringify({ key: k, calls: v.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) }));
  }
  console.log("STATUSES", JSON.stringify((data ?? []).reduce<Record<string, number>>((a, o) => { a[o.status] = (a[o.status] ?? 0) + 1; return a; }, {})));
  const { data: el } = await db.from("pi_paid_operations").select("method,committed_usd,capacity_units,status").eq("provider", "elevenlabs").eq("status", "COMMITTED").order("created_at", { ascending: false }).limit(20);
  console.log("ELEVENLABS_RECENT", JSON.stringify(el?.map(o => ({ method: o.method, usd: o.committed_usd, units: o.capacity_units }))));
  const { data: rw } = await db.from("pi_paid_operations").select("method,committed_usd,capacity_units,status").eq("provider", "runway").order("created_at", { ascending: false }).limit(10);
  console.log("RUNWAY_RECENT", JSON.stringify(rw?.map(o => ({ method: o.method, usd: o.committed_usd, units: o.capacity_units, status: o.status }))));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
