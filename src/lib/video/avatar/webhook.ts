import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AvatarJobStatus, AvatarVideoProvider } from "@/lib/providers/avatar";

/**
 * Lógica del webhook de avatar, separada de la ruta HTTP
 * (src/app/api/webhooks/avatar/[provider]/route.ts) para poder probarla
 * sin un servidor Next.js real ni Supabase real — mismo criterio que
 * visual-resource-planner.ts/visual-resource-resolver.ts (decisión pura
 * separada del I/O real).
 */

/** Comparación de secreto compartido — nunca autentica si falta cualquiera de los dos lados.
 *  El digest iguala la longitud para que `timingSafeEqual` no filtre el prefijo ni la longitud del secreto. */
export function verifyWebhookSecret(expectedSecret: string | undefined, providedSecret: string | null): boolean {
  if (!expectedSecret || !providedSecret) return false;
  const expected = createHash("sha256").update(expectedSecret).digest();
  const provided = createHash("sha256").update(providedSecret).digest();
  return timingSafeEqual(expected, provided);
}

/**
 * Firma oficial de HeyGen v3: HMAC-SHA256 hex del cuerpo crudo, header `signature`.
 * https://developers.heygen.com/docs/webhooks
 * El secreto es el que devuelve POST /v3/webhooks/endpoints (HEYGEN_WEBHOOK_SECRET).
 * No sustituye al header propio de Atomivid y no autentica si el secreto no está configurado.
 */
export function verifyHeygenWebhookSignature(secret: string | undefined, rawBody: string, signature: string | null): boolean {
  if (!secret || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATUS_RANK: Record<AvatarJobStatus, number> = { queued: 0, processing: 1, completed: 2, failed: 2, cancelled: 2 };

/**
 * Estados previos desde los que un callback puede escribir `next` sin
 * retroceder: queued → processing → (completed | failed | cancelled). Un
 * estado terminal nunca se sobrescribe con otro distinto, y repetir el mismo
 * estado es idempotente. La ruta lo aplica como condición del UPDATE
 * (`.in("avatar_render_status", …)`), así la regla se evalúa de forma atómica
 * en la base de datos aunque lleguen callbacks duplicados, tardíos o
 * desordenados.
 */
export function avatarStatusesThatMayAdvanceTo(next: AvatarJobStatus): AvatarJobStatus[] {
  return (Object.keys(STATUS_RANK) as AvatarJobStatus[]).filter(
    (prev) => prev === next || STATUS_RANK[prev] < STATUS_RANK[next],
  );
}

export type UpdateJobStatus = (providerJobId: string, status: AvatarJobStatus) => Promise<{ error: string | null }>;

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

export async function handleAvatarWebhook({
  provider,
  rawPayload,
  updateJobStatus,
}: {
  provider: AvatarVideoProvider;
  rawPayload: unknown;
  updateJobStatus: UpdateJobStatus;
}): Promise<WebhookOutcome> {
  const result = provider.processWebhookPayload(rawPayload);
  if (!result) {
    return { status: 400, body: { error: "unrecognized payload" } };
  }

  const { error } = await updateJobStatus(result.providerJobId, result.status);
  if (error) {
    return { status: 500, body: { error: "internal error" } };
  }

  return { status: 200, body: { received: true } };
}
