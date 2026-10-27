/**
 * Piloto del dueño: el generador (GitHub Actions) no conoce la identidad del dueño (el secreto
 * INTERNAL_PRODUCTION_OWNER_USER_ID solo existe en la app), así que le pregunta a la app si una cuenta es la del dueño.
 * Petición firmada con HMAC (clave de servicio, como la sonda de configuración) y ligada a la cuenta consultada.
 * La respuesta es solo un sí/no; nunca devuelve la identidad del dueño.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const STUDIO_OWNER_PATH = "/api/internal/studio-owner";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function studioOwnerSignature(secret: string, userId: string, nonce: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`atomivid-studio-owner-v1\nPOST\n${STUDIO_OWNER_PATH}\n${userId.toLowerCase()}\n${nonce}\n${timestamp}`).digest("hex");
}

export function validStudioOwnerSignature(secret: string | undefined, userId: string, nonce: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !UUID.test(userId) || !UUID.test(nonce) || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(studioOwnerSignature(secret, userId, nonce, timestamp)));
}

/** Lado del generador: pregunta a la app (fail closed ante cualquier error o respuesta inesperada). */
export async function askAppIsStudioOwner(userId: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const secret = env.SUPABASE_SERVICE_ROLE_KEY?.trim(), base = env.PODCAST_V3_APP_URL?.trim() || "https://atomivid.vercel.app";
  if (!secret || !UUID.test(userId)) return false;
  const { randomUUID } = await import("node:crypto");
  const nonce = randomUUID(), timestamp = String(Date.now());
  try {
    const res = await fetchImpl(`${base}${STUDIO_OWNER_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", "x-probe-nonce": nonce, "x-probe-time": timestamp, "x-probe-signature": studioOwnerSignature(secret, userId, nonce, timestamp) },
      body: JSON.stringify({ userId }) });
    if (!res.ok) return false;
    const body = (await res.json()) as { owner?: unknown };
    return body.owner === true;
  } catch { return false; }
}
