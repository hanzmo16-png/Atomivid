/** FREE Recraft (fal.ai) diagnosis: no generation. Auth probe = status of a non-existent queue request (no charge). */
import { createClient } from "@supabase/supabase-js";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const key = process.env.FAL_KEY?.trim();
  const out: Record<string, unknown> = { falKeyPresent: !!key && key !== "set", falAdminKeyPresent: !!process.env.FAL_ADMIN_KEY?.trim() };
  if (key && key !== "set") {
    const r = await fetch("https://queue.fal.run/recraft/v4/requests/00000000-0000-4000-8000-000000000000/status", { headers: { Authorization: `Key ${key}` }, redirect: "error", signal: AbortSignal.timeout(15000) }).catch((e) => ({ status: -1, text: async () => String(e) }) as never);
    out.authProbeStatus = (r as Response).status; // 401/403 = clave inválida; 404/422/400 = clave aceptada (solicitud inexistente)
    out.authProbeBody = (await (r as Response).text()).slice(0, 160);
  }
  const schema = await fetch("https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=recraft/v4/style/text-to-image", { signal: AbortSignal.timeout(15000) }).catch(() => null);
  out.modelSchemaStatus = schema?.status ?? null;
  if (schema?.ok) { const j = await schema.json() as Record<string, any>; out.modelHasPrompt = JSON.stringify(j).includes("\"prompt\""); out.modelHasStyleId = JSON.stringify(j).includes("style_id"); }
  const admin = process.env.FAL_ADMIN_KEY?.trim();
  if (admin) { const b = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", { headers: { Authorization: `Key ${admin}` } }); out.billingStatus = b.status; }
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const st = await db.rpc("pi_supply_state", { p_provider: "recraft" });
  const { data: pol } = await db.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls").eq("provider", "recraft").maybeSingle();
  const { data: snap } = await db.from("pi_capacity_snapshots").select("available,health,reliability,checked_at").eq("provider", "recraft").order("checked_at", { ascending: false }).limit(1);
  log("RECRAFT_PROBE", { ...out, supplyState: st.data ?? st.error?.message, policy: pol, lastSnapshot: snap?.[0] ?? null });
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
