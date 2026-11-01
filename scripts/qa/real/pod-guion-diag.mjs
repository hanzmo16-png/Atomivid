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
// Topes que comprueba pi_submit_with_supply (mismas funciones SQL, que solo leen): gasto del día y del mes (zona de la
// política) por proveedor y global, y saldo sin reservar de Anthropic frente a una reserva de guion típica.
{
  const tz = "America/Cancun";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const off = "-05:00"; // Cancún no tiene horario de verano
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00${off}`).toISOString(), month = new Date(`${parts.year}-${parts.month}-01T00:00:00${off}`).toISOString();
  const spend = async (p, s) => { const { data, error } = await db.rpc("pi_supply_spend", { p_provider: p, p_start: s }); return error ? `error: ${error.message}` : data; };
  out("SPEND", { day, month, anthropicDay: await spend("anthropic", day), anthropicMonth: await spend("anthropic", month), globalDay: await spend(null, day), globalMonth: await spend(null, month) });
  out("ANTHROPIC_BALANCE", { free: st?.free ?? null, unreserved: st?.unreserved ?? null, held: st?.held ?? null, remainingRatio: st?.remainingRatio ?? null, coverageHours: st?.coverageHours ?? null });
  const { data: jr } = await db.from("pi_supply_job_reservations").select("provider, status, reserved_usd, consumed_usd, created_at").eq("status", "OPEN");
  out("OPEN_JOB_RESERVATIONS", { n: (jr ?? []).length, byProvider: (jr ?? []).reduce((m, r) => { m[r.provider] = Math.round(((m[r.provider] ?? 0) + Number(r.reserved_usd) - Number(r.consumed_usd)) * 1e4) / 1e4; return m; }, {}), oldest: (jr ?? []).map((r) => r.created_at).sort()[0] ?? null });
  const { data: unres } = await db.from("pi_paid_operations").select("provider, status, reserved_usd, created_at").in("status", ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]).neq("method", "capacity_hold");
  out("UNRESOLVED_OPS", { n: (unres ?? []).length, byProvider: (unres ?? []).reduce((m, r) => { const k = `${r.provider}/${r.status}`; m[k] = Math.round(((m[k] ?? 0) + Number(r.reserved_usd)) * 1e4) / 1e4; return m; }, {}) });
}
// Primer control de pi_submit_with_supply: política global con evidencia; y todas las llamadas de guion de podcast-studio
// (cualquier fecha) y las de Anthropic sin resolver, para ver si alguna vez se admitió una y qué bloquea.
{
  const { data: g } = await db.from("pi_supply_policies").select("*").in("provider", ["__global__", "anthropic"]);
  out("POLICY_EVIDENCE", (g ?? []).map((p) => ({ provider: p.provider, evidenceChars: String(p.evidence ?? "").trim().length, baseline: p.baseline ?? null, updated_at: p.updated_at ?? null })));
  const { data: all } = await db.from("pi_paid_operations").select("status, created_at, updated_at, model").like("project_id", "podcast-studio:%").order("created_at", { ascending: true });
  out("PODCAST_STUDIO_ALL", (all ?? []).map((o) => ({ status: o.status, created_at: o.created_at, model: o.model })));
  const { data: rec } = await db.from("pi_paid_operations").select("project_id, method, status, created_at, updated_at, provider_job_id").eq("provider", "anthropic").in("status", ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]);
  out("ANTHROPIC_UNRESOLVED", (rec ?? []).map((o) => ({ project: String(o.project_id).replace(/[0-9a-f-]{36}/gi, "<id>").slice(0, 60), method: o.method, status: o.status, created_at: o.created_at, updated_at: o.updated_at, job: !!o.provider_job_id })));
  const { data: lastOk } = await db.from("pi_paid_operations").select("project_id, created_at").eq("provider", "anthropic").in("status", ["COMMITTED", "SUBMITTED", "PROVIDER_JOB_RECORDED"]).order("created_at", { ascending: false }).limit(3);
  out("ANTHROPIC_LAST_ADMITTED", (lastOk ?? []).map((o) => ({ project: String(o.project_id).replace(/[0-9a-f-]{36}/gi, "<id>").slice(0, 40), created_at: o.created_at })));
}
// ¿Está aplicada la propuesta spend_authorizations (pi_submit_with_supply exige una autorización ACTIVA para todo
// project_id 'podcast-%', y «podcast-studio:…» encaja)? Solo lectura: existencia de la tabla y recuentos por prefijo.
{
  const { data, error } = await db.from("pi_spend_authorizations").select("project_id, status, created_at").limit(200);
  out("SPEND_AUTHORIZATIONS", { applied: !error, error: error?.message?.slice(0, 120) ?? null, n: (data ?? []).length,
    studio: (data ?? []).filter((r) => String(r.project_id).startsWith("podcast-studio")).length,
    byStatus: (data ?? []).reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}), latest: (data ?? []).map((r) => r.created_at).sort().at(-1) ?? null });
}
