/**
 * Mystery Shopper 3.0 — resultado del inicio de sesión de la cuenta QA.
 *
 * Causa raíz de la ejecución #18 (run 45303828882): la app redirige a /login?error=… cuando Supabase
 * responde «Invalid login credentials», pero el worker solo esperaba /dashboard y terminaba con un
 * «Timeout 30000ms» genérico. Este módulo convierte la URL/alerta observada en un diagnóstico exacto,
 * sin leer ni imprimir la contraseña. USD 0.
 */
export type AuthOutcomeKind =
  | "ok"
  | "missing_secrets"
  | "bad_credentials"
  | "email_unconfirmed"
  | "rate_limited"
  | "preview_protected"
  | "timeout"
  | "unknown_error";

export type AuthOutcome = {
  kind: AuthOutcomeKind;
  state: "PASS" | "FAIL" | "BLOCKED";
  /** Severidad de la incidencia si no es PASS. */
  severity: "P0" | "P1" | null;
  detail: string;
  /** Acción humana exacta (o null). Nunca incluye valores de secretos. */
  humanGate: string | null;
};

const GATES: Record<Exclude<AuthOutcomeKind, "ok">, string> = {
  missing_secrets: "Falta la cuenta QA: guardar MYSTERY_SHOPPER_QA_EMAIL y MYSTERY_SHOPPER_QA_PASSWORD como secretos del repositorio.",
  bad_credentials: "La cuenta QA no entra: el correo o la contraseña guardados en los secretos MYSTERY_SHOPPER_QA_* no coinciden con un usuario de Supabase Auth. Restablecer la contraseña de la cuenta QA dedicada y volver a guardar el secreto (sin pegarla en chats).",
  email_unconfirmed: "La cuenta QA existe pero su correo no está confirmado en Supabase Auth.",
  rate_limited: "Supabase Auth limitó los intentos de inicio de sesión; esperar y reintentar (no reintentar en bucle).",
  preview_protected: "El Preview está protegido por Vercel: falta el secreto VERCEL_AUTOMATION_BYPASS_SECRET en el worker.",
  timeout: "El inicio de sesión no terminó en el tiempo límite y la app no mostró ningún error: revisar la acción de login y Supabase.",
  unknown_error: "La app mostró un error al iniciar sesión que no es de credenciales: revisar Supabase Auth.",
};

/** Clasifica lo observado tras pulsar «Iniciar sesión». Función pura. */
export function classifyAuth(input: {
  hasEmail: boolean;
  hasPassword: boolean;
  finalUrl: string | null;
  alertText?: string | null;
  httpStatus?: number | null;
  timedOut?: boolean;
}): AuthOutcome {
  if (!input.hasEmail || !input.hasPassword) return out("missing_secrets", "BLOCKED", null, "No hay cuenta QA configurada. No se inventa una sesión.");
  if (input.httpStatus === 401 || input.httpStatus === 403) return out("preview_protected", "BLOCKED", null, `HTTP ${input.httpStatus}: protección de Vercel.`);
  let path = "", err = "";
  try {
    const u = new URL(input.finalUrl ?? "");
    path = u.pathname;
    err = u.searchParams.get("error") ?? "";
  } catch { /* URL ausente */ }
  if (/^\/dashboard(\/|$)/.test(path)) return { kind: "ok", state: "PASS", severity: null, detail: "Sesión iniciada; panel visible.", humanGate: null };
  const text = `${err} ${input.alertText ?? ""}`.trim();
  if (/contraseña incorrectos|invalid login credentials/i.test(text)) return out("bad_credentials", "BLOCKED", "P0", "La app respondió «Correo o contraseña incorrectos.» para la cuenta QA.");
  if (/confirma tu correo|email not confirmed/i.test(text)) return out("email_unconfirmed", "BLOCKED", "P0", "La app pide confirmar el correo de la cuenta QA.");
  if (/demasiados intentos|rate limit/i.test(text)) return out("rate_limited", "BLOCKED", "P1", "Supabase limitó los intentos de inicio de sesión.");
  if (text) return out("unknown_error", "FAIL", "P0", `La app mostró un error al iniciar sesión: «${text.slice(0, 160)}».`);
  if (input.timedOut) return out("timeout", "FAIL", "P0", `El login no redirigió al panel ni mostró error (URL final: ${path || "desconocida"}).`);
  return out("unknown_error", "FAIL", "P0", `Tras el login la URL quedó en ${path || "desconocida"} sin panel.`);
}

function out(kind: Exclude<AuthOutcomeKind, "ok">, state: AuthOutcome["state"], severity: AuthOutcome["severity"], detail: string): AuthOutcome {
  return { kind, state, severity, detail, humanGate: GATES[kind] };
}
