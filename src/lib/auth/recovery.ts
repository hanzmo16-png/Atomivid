/**
 * Recuperación de contraseña — la cuenta de un usuario que la olvidó no
 * tenía, hasta ahora, ninguna forma de recuperarla por su cuenta (ver
 * RC mission Fase 0: gap real confirmado, ningún flujo equivalente en
 * /login, /register ni /auth/callback).
 *
 * Diseño: /auth/callback ya intercambia el `code` del enlace de Supabase
 * por una sesión — cuando ese intercambio es específicamente de tipo
 * "recovery" (nunca por un simple `?next=` en la URL, que cualquiera
 * podría fabricar), guarda una prueba HMAC de corta duración
 * (RECOVERY_COOKIE) atada al access_token de ESA sesión concreta. Solo con
 * esa prueba válida /reset-password permite cambiar la contraseña — nunca
 * confía en la sola presencia de una sesión activa (eso permitiría a
 * cualquiera con la cookie de sesión de otro cambiarle la contraseña).
 *
 * La clave de firma reutiliza SUPABASE_SERVICE_ROLE_KEY (ya secreta,
 * server-only) en vez de inventar una variable de entorno nueva — nunca se
 * expone al cliente ni se registra en logs.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RECOVERY_COOKIE = "atomivid-recovery";
export const RECOVERY_SECONDS = 900;

/** Nunca confirma ni niega si existe una cuenta con el correo dado. */
export const RECOVERY_MESSAGE =
  "Si existe una cuenta con ese correo, recibirás un enlace para cambiar tu contraseña. " +
  "Esto no confirma que el correo llegó — revisa también spam y abre el enlace más reciente " +
  "en este mismo navegador. Evita solicitar varios enlaces seguidos.";

export function passwordError(password: string, confirmation: string): string | null {
  if (password.length < 12 || password.length > 128) {
    return "Usa entre 12 y 128 caracteres. Puedes usar una frase larga en vez de una contraseña compleja.";
  }
  if (password !== confirmation) return "Las contraseñas no coinciden.";
  return null;
}

function signature(value: string, key: string): string {
  return createHmac("sha256", key).update(`atomivid:recovery:v1:${value}`).digest("hex");
}

/** Huella del access_token, nunca el token crudo, dentro de la prueba (que puede acabar en un log de errores). */
function fingerprint(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

export function createRecoveryProof(userId: string, accessToken: string, key: string, now = Date.now()): string {
  const value = Buffer.from(
    JSON.stringify({ userId, token: fingerprint(accessToken), expires: now + RECOVERY_SECONDS * 1000 }),
  ).toString("base64url");
  return `${value}.${signature(value, key)}`;
}

/**
 * Verifica que `proof` (a) esté firmado con `key`, (b) corresponda al
 * MISMO userId y access_token de la sesión actual, y (c) no haya expirado
 * — las tres condiciones a la vez, nunca solo una. `timingSafeEqual` evita
 * una comparación de firma vulnerable a timing attack.
 */
export function validRecoveryProof(
  proof: string | undefined,
  userId: string,
  accessToken: string,
  key: string,
  now = Date.now(),
): boolean {
  if (!proof || !userId || !accessToken || !key) return false;
  try {
    const [value, sig, extra] = proof.split(".");
    if (extra !== undefined || !value || !sig || !/^[a-f0-9]{64}$/.test(sig)) return false;
    const expectedSig = signature(value, key);
    if (expectedSig.length !== sig.length || !timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig))) return false;
    const data = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      userId?: unknown;
      token?: unknown;
      expires?: unknown;
    };
    return (
      data.userId === userId &&
      data.token === fingerprint(accessToken) &&
      typeof data.expires === "number" &&
      Number.isFinite(data.expires) &&
      data.expires > now &&
      data.expires <= now + RECOVERY_SECONDS * 1000
    );
  } catch {
    return false;
  }
}
