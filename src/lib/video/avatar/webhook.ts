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
