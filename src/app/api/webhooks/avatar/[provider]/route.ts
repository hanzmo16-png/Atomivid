import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureAvatarProvider } from "@/lib/providers/avatar/fixture";
import { heygenAvatarProvider } from "@/lib/providers/avatar/heygen";
import type { AvatarVideoProvider } from "@/lib/providers/avatar";
import { avatarStatusesThatMayAdvanceTo, handleAvatarWebhook, verifyHeygenWebhookSignature, verifyWebhookSecret } from "@/lib/video/avatar/webhook";

/**
 * Webhook para que un proveedor de avatar notifique que un video terminó
 * (o falló) sin que el pipeline tenga que sondear indefinidamente. Nunca
 * es la única vía — checkVideoStatus() (sondeo) sigue funcionando si el
 * webhook nunca llega, así que perderse uno no cuelga ninguna solicitud.
 *
 * Autenticación, cualquiera de las dos, antes de interpretar el cuerpo:
 * 1. Secreto propio `X-Atomivid-Webhook-Secret` (AVATAR_WEBHOOK_SECRET).
 * 2. Firma oficial HeyGen v3 (`signature` = HMAC-SHA256 hex del cuerpo
 *    crudo) solo para el proveedor heygen y solo si HEYGEN_WEBHOOK_SECRET
 *    está configurado. Sin ese secreto la firma no autentica: no se inventa
 *    una clave y no se rota ningún secreto desde este proceso.
 * Un fallo de ambas responde 401. La lógica de negocio vive en
 * video/avatar/webhook.ts (probada sin Supabase/Next.js reales).
 */

const PROVIDERS: Record<string, AvatarVideoProvider> = {
  fixture: fixtureAvatarProvider,
  heygen: heygenAvatarProvider,
};

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const flags = getFeatureFlags();
  if (!flags.avatarModeEnabled) {
    // Nunca revela si la ruta existe cuando el modo avatar está apagado.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { provider: providerName } = await params;
  const headerOk = verifyWebhookSecret(process.env.AVATAR_WEBHOOK_SECRET?.trim(), request.headers.get("x-atomivid-webhook-secret"));
  let raw: string | null = null;
  if (!headerOk) {
    if (providerName !== "heygen") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    raw = await request.text();
    const signed = verifyHeygenWebhookSignature(process.env.HEYGEN_WEBHOOK_SECRET?.trim(), raw, request.headers.get("signature"));
    if (!signed) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const provider = PROVIDERS[providerName];
  if (!provider) {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw ?? await request.text());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const outcome = await handleAvatarWebhook({
    provider,
    rawPayload: payload,
    updateJobStatus: async (providerJobId, status) => {
      const service = createServiceClient();
      const { error } = await service
        .from("video_requests")
        .update({ avatar_render_status: status })
        .eq("avatar_provider_video_job_id", providerJobId)
        // Un callback tardío o desordenado nunca retrocede el estado (p. ej. completed → processing).
        .in("avatar_render_status", avatarStatusesThatMayAdvanceTo(status));
      if (error) {
        // El detalle del error de Supabase nunca se expone al llamador externo.
        console.error(`[atomivid:avatar-webhook] no se pudo actualizar video_requests para el job ${providerJobId}:`, error.message);
        return { error: error.message };
      }
      return { error: null };
    },
  });

  return NextResponse.json(outcome.body, { status: outcome.status });
}
