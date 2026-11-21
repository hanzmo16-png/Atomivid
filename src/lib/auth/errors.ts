/**
 * Supabase Auth devuelve error.message en inglés y con redacción técnica
 * ("Invalid login credentials", "User already registered"...). Esta tabla
 * traduce los casos más comunes a mensajes humanos en español; cualquier
 * mensaje no reconocido cae a un texto genérico en vez de mostrar el
 * string crudo del proveedor al usuario.
 */
const KNOWN_PATTERNS: Array<{ match: RegExp; message: string }> = [
  { match: /invalid login credentials/i, message: "Correo o contraseña incorrectos." },
  { match: /email not confirmed/i, message: "Confirma tu correo antes de iniciar sesión — revisa tu bandeja de entrada." },
  { match: /user already registered/i, message: "Ya existe una cuenta con ese correo. Intenta iniciar sesión." },
  { match: /password should be at least/i, message: "La contraseña debe tener al menos 6 caracteres." },
  { match: /unable to validate email address/i, message: "Ese correo no es válido." },
  // Must precede the generic rate-limit pattern: the account was not created because the confirmation
  // email could not be sent (project-wide email quota or SMTP failure) — not the visitor's fault.
  { match: /email rate limit|over_email_send_rate_limit|error sending (confirmation|magic link|recovery) email/i, message: "No pudimos enviar el correo de confirmación en este momento, así que la cuenta no se creó. Intenta de nuevo más tarde." },
  { match: /rate limit/i, message: "Demasiados intentos. Espera un momento y vuelve a intentarlo." },
  { match: /network/i, message: "No se pudo conectar. Revisa tu conexión e intenta de nuevo." },
];

/**
 * Códigos estables de Supabase Auth (AuthError.code). Se consultan antes que el texto: el mensaje en inglés
 * puede cambiar entre versiones, el código no. Fue un 429 over_email_send_rate_limit lo que dejó sin cuenta
 * al cliente de prueba del 9 de octubre.
 */
const KNOWN_CODES: Record<string, string> = {
  invalid_credentials: "Correo o contraseña incorrectos.",
  email_not_confirmed: "Confirma tu correo antes de iniciar sesión — revisa tu bandeja de entrada.",
  user_already_exists: "Ya existe una cuenta con ese correo. Intenta iniciar sesión.",
  email_exists: "Ya existe una cuenta con ese correo. Intenta iniciar sesión.",
  weak_password: "La contraseña es demasiado débil. Usa al menos 6 caracteres.",
  email_address_invalid: "Ese correo no es válido.",
  validation_failed: "Revisa el correo y la contraseña.",
  over_email_send_rate_limit: "No pudimos enviar el correo de confirmación en este momento, así que la cuenta no se creó. Intenta de nuevo más tarde.",
  over_request_rate_limit: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
  signup_disabled: "El registro de cuentas nuevas está cerrado en este momento.",
  email_provider_disabled: "El registro con correo está cerrado en este momento.",
};

export function humanizeAuthError(rawMessage: string | undefined | null, code?: string | null): string {
  if (code && KNOWN_CODES[code]) return KNOWN_CODES[code];
  if (!rawMessage) return "Ocurrió un error inesperado. Intenta de nuevo.";
  const found = KNOWN_PATTERNS.find((p) => p.match.test(rawMessage));
  return found ? found.message : "No se pudo completar la solicitud. Intenta de nuevo en un momento.";
}

/**
 * Solo redirige dentro del sitio — nunca a una URL absoluta/externa (evita
 * un open redirect vía el parámetro redirectedFrom) ni de vuelta a
 * login/register (evitaría un loop).
 */
export function safeRedirectTarget(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.startsWith("/login") || value.startsWith("/register")) return null;
  return value;
}
