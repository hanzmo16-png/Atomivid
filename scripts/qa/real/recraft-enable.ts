/**
 * Activa la política de suministro de Recraft para Podcast Studio (encargo del dueño del 2026-10-28: «Integra Recraft
 * como proveedor principal de imágenes ilustrativas del Podcast»). Compare-and-set: solo pasa enabled false→true si la
 * fila está exactamente como se auditó; los topes (USD/día, USD/mes, llamadas/día, concurrencia) NO cambian.
 * MODO=dry no escribe.
 */
import { createClient } from "@supabase/supabase-js";
const FIELDS = "provider,enabled,max_daily_calls,daily_cap_usd,monthly_cap_usd,max_concurrent,evidence";
async function main() {
  const apply = process.env.MODO === "apply";
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: before, error: e0 } = await db.from("pi_supply_policies").select(FIELDS).eq("provider", "recraft").single();
  if (e0 || !before) throw new Error(`recraft policy not found: ${e0?.message ?? ""}`);
  console.log("BEFORE", JSON.stringify({ ...before, evidence: `${String(before.evidence ?? "").length} chars` }));
  if (before.enabled !== false) { console.log(`SKIP: enabled is ${before.enabled}`); return; }
  if (!apply) { console.log("DRY recraft: enabled false → true (caps unchanged)"); return; }
  const evidence = `${before.evidence ?? ""}\n[2026-10-28 enabled false→true] Recraft pasa a ser el proveedor de ilustraciones de Podcast Studio (encargo del dueño). Topes sin cambio.`;
  const { data: after, error } = await db.from("pi_supply_policies").update({ enabled: true, evidence, updated_at: new Date().toISOString() })
    .eq("provider", "recraft").eq("enabled", false).select(FIELDS).single();
  if (error || !after) throw new Error(`update failed: ${error?.message ?? "no row"}`);
  console.log("AFTER", JSON.stringify({ ...after, evidence: `${String(after.evidence ?? "").length} chars` }));
  if (after.daily_cap_usd !== before.daily_cap_usd || after.monthly_cap_usd !== before.monthly_cap_usd || after.max_daily_calls !== before.max_daily_calls || after.max_concurrent !== before.max_concurrent) throw new Error("caps changed unexpectedly");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
