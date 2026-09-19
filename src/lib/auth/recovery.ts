import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const RECOVERY_COOKIE = "atomivid-recovery";
export const RECOVERY_SECONDS = 900;
export const RECOVERY_MESSAGE = "Solicitud aceptada. Si existe una cuenta con ese correo y el envío está permitido, recibirás un enlace para cambiar tu contraseña. Esto no confirma la entrega del correo. Revisa también spam y abre el enlace más reciente en este mismo navegador. Evita solicitar varios enlaces seguidos.";

export function recoveryOrigin(raw: string | undefined): string {
  if (!raw) throw new Error("Recovery origin missing");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("Invalid recovery origin");
  }
  return url.origin;
}

export function passwordError(password: string, confirmation: string): string | null {
  if (password.length < 12 || password.length > 128) return "Usa entre 12 y 128 caracteres. Puedes usar una frase larga.";
  if (password !== confirmation) return "Las contraseñas no coinciden.";
  return null;
}

function signature(value: string, key: string) {
  if (!key) throw new Error("Recovery signing key missing");
  return createHmac("sha256", key).update("atomivid:recovery:v1:" + value).digest("hex");
}
function fingerprint(accessToken: string) { return createHash("sha256").update(accessToken).digest("hex"); }
export function createRecoveryProof(userId: string, accessToken: string, key: string, now = Date.now()): string {
  const value = Buffer.from(JSON.stringify({ userId, token: fingerprint(accessToken), expires: now + RECOVERY_SECONDS * 1000 })).toString("base64url");
  return `${value}.${signature(value, key)}`;
}
export function validRecoveryProof(proof: string | undefined, userId: string, accessToken: string, key: string, now = Date.now()): boolean {
  if (!proof || !userId || !accessToken || !key) return false;
  try {
    const [value, sig, extra] = proof.split(".");
    if (extra || !/^[a-f0-9]{64}$/.test(sig)) return false;
    if (!timingSafeEqual(Buffer.from(signature(value, key)), Buffer.from(sig))) return false;
    const data = JSON.parse(Buffer.from(value, "base64url").toString());
    return data.userId === userId && data.token === fingerprint(accessToken) && Number.isFinite(data.expires) && data.expires > now && data.expires <= now + RECOVERY_SECONDS * 1000;
  } catch { return false; }
}
