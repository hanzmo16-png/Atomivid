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
