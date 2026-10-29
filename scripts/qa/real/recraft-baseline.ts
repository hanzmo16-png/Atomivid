/**
 * Recraft: completa la política de suministro (PREPARADO, no aplicado sin autorización del dueño). La base devuelve
 * «policy unconfigured» porque pi_supply_policies.baseline = 0 para recraft (las demás condiciones ya se cumplen).
 * Compare-and-set: solo pasa baseline 0 → BASELINE_USD si la fila está exactamente como se auditó el 2026-10-29
 * (enabled, unit usd, unit_cost 1, topes 10/50, 250 llamadas, concurrencia 1). Topes, cuotas y enabled NO cambian.
 * El saldo NO se inventa: sin FAL_ADMIN_KEY (lectura oficial de facturación) Recraft sigue bloqueado, como debe.
 * MODO=dry (por defecto) no escribe.
 */
import { createClient } from "@supabase/supabase-js";
const FIELDS = "provider,enabled,unit,unit_cost_usd,baseline,max_daily_calls,daily_cap_usd,monthly_cap_usd,max_concurrent,daily_forecast";
async function main() {
  const apply = process.env.MODO === "apply", baseline = Number(process.env.BASELINE_USD ?? "");
  if (!(baseline > 0 && baseline <= 100)) throw new Error("BASELINE_USD debe ser > 0 y ≤ 100 (saldo de referencia de fal.ai en USD)");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: before, error: e0 } = await db.from("pi_supply_policies").select(FIELDS).eq("provider", "recraft").single();
  if (e0 || !before) throw new Error(`recraft policy not found: ${e0?.message ?? ""}`);
  console.log("BEFORE", JSON.stringify(before));
  const audited = before.enabled === true && before.unit === "usd" && Number(before.unit_cost_usd) === 1 && Number(before.daily_cap_usd) === 10
    && Number(before.monthly_cap_usd) === 50 && Number(before.max_daily_calls) === 250 && Number(before.max_concurrent) === 1;
  if (!audited) { console.log("SKIP: la fila no coincide con la auditada; no se toca"); process.exitCode = 1; return; }
  if (Number(before.baseline) !== 0) { console.log(`SKIP: baseline ya es ${before.baseline}`); return; }
  if (!apply) { console.log(`DRY recraft: baseline 0 → ${baseline} (topes, cuotas y enabled sin cambio)`); return; }
  const { data: after, error } = await db.from("pi_supply_policies").update({ baseline, updated_at: new Date().toISOString() })
    .eq("provider", "recraft").eq("baseline", 0).eq("enabled", true).eq("daily_cap_usd", 10).eq("monthly_cap_usd", 50).select(FIELDS).single();
  if (error || !after) throw new Error(`update failed: ${error?.message ?? "no row"}`);
  console.log("AFTER", JSON.stringify(after));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
