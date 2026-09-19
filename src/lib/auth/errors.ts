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
  { match: /rate limit/i, message: "Demasiados intentos. Espera un momento y vuelve a intentarlo." },
  { match: /network/i, message: "No se pudo conectar. Revisa tu conexión e intenta de nuevo." },
];

export function humanizeAuthError(rawMessage: string | undefined | null): string {
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
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return null;
  if (value.startsWith("/login") || value.startsWith("/register")) return null;
  return value;
}
