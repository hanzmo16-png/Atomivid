/**
 * Mystery Shopper 3.0 — preflight de la cuenta QA (USD 0, solo lectura + un inicio de sesión de la propia cuenta QA).
 *
 * Distingue la causa exacta cuando el login falla, sin imprimir nunca correo ni contraseña:
 *   secrets_present · user_exists · email_confirmed · not_banned · is_admin (debe ser false) · password_ok
 * Entorno: NEXT_PUBLIC_SUPABASE_URL | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MYSTERY_SHOPPER_QA_EMAIL, MYSTERY_SHOPPER_QA_PASSWORD,
 *          MS_OUT_DIR (opcional), COMMAND_CENTER_ADMIN_EMAILS (opcional, para comprobar que la QA no es admin).
 * Salida: JSON con booleanos en stdout y en $MS_OUT_DIR/qa-preflight.json. Exit 0 si todo OK, 3 si no.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Result = {
  at: string; bindings: Record<string, boolean>; auth_status: number | null; logout_ok: boolean | null; secrets_present: boolean; user_exists: boolean | null; email_confirmed: boolean | null; not_banned: boolean | null;
  is_admin: boolean | null; password_ok: boolean | null; diagnosis: string;
};

export async function preflight(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<Result> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  const email = (env.MYSTERY_SHOPPER_QA_EMAIL ?? "").trim().toLowerCase(), password = env.MYSTERY_SHOPPER_QA_PASSWORD ?? "";
  const bindings = { supabase_url: !!url, service_role: !!key, qa_email: !!email, qa_password: !!password };
  const boundedFetch: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(15_000) });
  const r: Result = { at: new Date().toISOString(), bindings, auth_status: null, logout_ok: null, secrets_present: !!(email && password && url && key), user_exists: null, email_confirmed: null, not_banned: null, is_admin: null, password_ok: null, diagnosis: "" };
  if (!r.secrets_present) { r.diagnosis = "Faltan secretos (QA o Supabase) en el entorno del worker."; return r; }
  const admin = createClient(url!, key!, { global: { fetch: boundedFetch }, auth: { autoRefreshToken: false, persistSession: false } });
  type U = { email?: string; email_confirmed_at?: string | null; banned_until?: string | null; app_metadata?: Record<string, unknown> };
  let user: U | null = null;
  for (let page = 1; page <= 20 && !user; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { r.diagnosis = "No se pudo listar usuarios con la service role (revisar SUPABASE_SERVICE_ROLE_KEY)."; return r; }
    user = (data.users.find((u) => (u.email ?? "").toLowerCase() === email) as unknown as U | undefined) ?? null;
    if (data.users.length < 200) break;
  }
  r.user_exists = !!user;
  if (!user) { r.diagnosis = "El correo guardado en MYSTERY_SHOPPER_QA_EMAIL no corresponde a ningún usuario de Supabase Auth."; return r; }
  r.email_confirmed = !!user.email_confirmed_at;
  r.not_banned = !user.banned_until || new Date(user.banned_until).getTime() < Date.now();
  const admins = (env.COMMAND_CENTER_ADMIN_EMAILS ?? "").toLowerCase().split(/[,\s]+/).filter(Boolean);
  r.is_admin = admins.includes(email) || user.app_metadata?.role === "admin";
  const res = await boundedFetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key!, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }).catch(() => null);
  r.auth_status = res?.status ?? null;
  if (!res || res.status === 429 || res.status >= 500) { r.diagnosis = !res ? "No se pudo conectar con Supabase Auth (red o timeout)." : res.status === 429 ? "Supabase Auth limitó los intentos (429); no reintentar automáticamente." : "Supabase Auth devolvió un error de servidor; no se atribuye a la contraseña."; return r; }
  r.password_ok = res.ok;
  if (res && res.ok) {
    const body = await res.json().catch(() => null) as { access_token?: string } | null;
    if (body?.access_token) r.logout_ok = await boundedFetch(`${url}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: key!, Authorization: `Bearer ${body.access_token}` } }).then((response) => response.ok).catch(() => false);
  }
  r.diagnosis = !r.email_confirmed ? "El usuario QA existe pero el correo no está confirmado."
    : !r.not_banned ? "El usuario QA está suspendido (banned_until)."
    : !r.password_ok ? "El usuario QA existe y está confirmado, pero la contraseña de MYSTERY_SHOPPER_QA_PASSWORD no coincide."
    : !r.logout_ok ? "Inicio de sesión correcto, pero no se confirmó el cierre de la sesión de diagnóstico."
    : r.is_admin ? "La cuenta QA es administradora: debe ser una cuenta de cliente normal."
    : "Cuenta QA verificada: existe, confirmada, no suspendida, no admin, contraseña correcta.";
  return r;
}

const ok = (r: Result) => r.secrets_present && r.user_exists && r.email_confirmed && r.not_banned && r.password_ok && r.logout_ok && !r.is_admin;

if (process.argv[1] && /qa-preflight\.ts$/.test(process.argv[1])) {
  preflight(process.env).then(async (r) => {
    const out = JSON.stringify(r, null, 2);
    console.log(out);
    if (process.env.MS_OUT_DIR) { await mkdir(process.env.MS_OUT_DIR, { recursive: true }); await writeFile(path.join(process.env.MS_OUT_DIR, "qa-preflight.json"), out); }
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Cuenta QA\n\n${r.diagnosis}\n\n\`\`\`json\n${out}\n\`\`\`\n`, { flag: "a" });
    process.exit(ok(r) ? 0 : 3);
  }).catch(() => { console.log(JSON.stringify({ diagnosis: "El preflight falló antes de terminar." })); process.exit(3); });
}
