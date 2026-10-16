import type { AvatarJobStatus, AvatarVideoProvider } from "@/lib/providers/avatar";

/**
 * Lógica del webhook de avatar, separada de la ruta HTTP
 * (src/app/api/webhooks/avatar/[provider]/route.ts) para poder probarla
 * sin un servidor Next.js real ni Supabase real — mismo criterio que
 * visual-resource-planner.ts/visual-resource-resolver.ts (decisión pura
 * separada del I/O real).
 */

/** Comparación de secreto compartido — nunca autentica si falta cualquiera de los dos lados. */
export function verifyWebhookSecret(expectedSecret: string | undefined, providedSecret: string | null): boolean {
  return Boolean(expectedSecret) && Boolean(providedSecret) && expectedSecret === providedSecret;
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
