// Read-only (USD 0): guion con IA de Podcast Studio 3.0. Lista las llamadas generate_script del libro de la plataforma
// (pi_paid_operations) de los proyectos podcast-studio:* de las últimas 48 h: estado, modelo, montos, tiempos y errores.
// No imprime prompts, resultados, correos ni claves; el identificador del dueño se reemplaza por <owner>.
import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (k, v) => console.log(`${k} ${JSON.stringify(v)}`);
const since = new Date(Date.now() - 48 * 3600_000).toISOString();
const { data, error } = await db.from("pi_paid_operations").select("*").like("project_id", "podcast-studio:%").gte("created_at", since).order("created_at", { ascending: true });
out("COLUMNS", data?.[0] ? Object.keys(data[0]) : []);
out("N", { error: error?.message ?? null, n: (data ?? []).length });
for (const o of data ?? []) {
  const keep = {};
  for (const [k, v] of Object.entries(o)) {
    if (/fingerprint|result_ref|payload|prompt|response|idempotency/i.test(k)) continue;
    keep[k] = typeof v === "string" ? v.replace(/podcast-studio:[0-9a-f-]{36}/i, "podcast-studio:<owner>").slice(0, 200) : v;
  }
  out("OP", keep);
}
// Reservas abiertas del dueño (cuentan contra topes): estado y antigüedad.
const { data: open } = await db.from("pi_paid_operations").select("status, created_at, reserved_usd").like("project_id", "podcast-studio:%").in("status", ["RESERVED", "SUBMITTED", "RECONCILIATION_REQUIRED"]);
out("OPEN", (open ?? []).map((o) => ({ status: o.status, created_at: o.created_at, reserved_usd: o.reserved_usd })));
// Por qué pi_submit_with_supply no admite la llamada (solo lecturas; pi_supply_state no escribe): política, última
// lectura de saldo de Anthropic y estado calculado. Sin montos de otras cuentas: solo nivel, motivo y fechas.
const { data: pol } = await db.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,max_concurrent,max_daily_calls,daily_cap_usd,monthly_cap_usd,timezone").in("provider", ["anthropic", "__global__"]);
out("POLICY", pol ?? []);
const { data: snaps } = await db.from("pi_capacity_snapshots").select("provider,unit,reliability,checked_at,health").eq("provider", "anthropic").order("checked_at", { ascending: false }).limit(3);
out("ANTHROPIC_SNAPSHOTS", snaps ?? []);
const { data: st, error: se } = await db.rpc("pi_supply_state", { p_provider: "anthropic" });
out("ANTHROPIC_STATE", { error: se?.message ?? null, level: st?.level ?? null, reason: st?.reason ?? null, activeCalls: st?.activeCalls ?? null, todayCalls: st?.todayCalls ?? null });
// Documentales (Long Form): cómo consiguen admisión sus guiones (estado de sus últimas llamadas de Anthropic).
const { data: lf } = await db.from("pi_paid_operations").select("status, created_at, supply_job_key").eq("provider", "anthropic").like("project_id", "documentary:%").order("created_at", { ascending: false }).limit(5);
out("LF_RECENT", (lf ?? []).map((o) => ({ status: o.status, created_at: o.created_at, job: !!o.supply_job_key })));
// Rechazos registrados (REFUNDED con motivo) de podcast-studio: solo el prefijo de motivo, nunca un resultado pagado.
const { data: rej } = await db.from("pi_paid_operations").select("status, result_ref, created_at").like("project_id", "podcast-studio:%").eq("status", "REFUNDED").limit(10);
out("REJECTED", (rej ?? []).map((o) => ({ created_at: o.created_at, why: String(o.result_ref ?? "").startsWith("rejected:") ? String(o.result_ref).slice(0, 160) : "(otro)" })));
