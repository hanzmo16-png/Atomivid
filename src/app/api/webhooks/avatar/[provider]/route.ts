import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureAvatarProvider } from "@/lib/providers/avatar/fixture";
import { heygenAvatarProvider } from "@/lib/providers/avatar/heygen";
import type { AvatarVideoProvider } from "@/lib/providers/avatar";
import { handleAvatarWebhook, verifyWebhookSecret } from "@/lib/video/avatar/webhook";

/**
 * Webhook para que un proveedor de avatar notifique que un video terminó
 * (o falló) sin que el pipeline tenga que sondear indefinidamente. Nunca
 * es la única vía — checkVideoStatus() (sondeo) sigue funcionando si el
 * webhook nunca llega, así que perderse uno no cuelga ninguna solicitud.
 *
 * Autenticación: NINGÚN mecanismo de firma de webhook de HeyGen pudo
 * confirmarse contra la documentación oficial primaria (ver
 * providers/avatar/heygen.ts) — en vez de inventar una verificación de
 * firma que no se pudo confirmar, este endpoint exige un secreto
 * compartido PROPIO (AVATAR_WEBHOOK_SECRET, configurado por nosotros al
 * registrar la URL del webhook en el proveedor) en el header
 * `X-Atomivid-Webhook-Secret`. Sin ese secreto configurado, o si no
 * coincide, se rechaza con 401 ANTES de leer el cuerpo — nunca se procesa
 * un payload no autenticado. La lógica de negocio vive en
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

  const authenticated = verifyWebhookSecret(process.env.AVATAR_WEBHOOK_SECRET?.trim(), request.headers.get("x-atomivid-webhook-secret"));
  if (!authenticated) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { provider: providerName } = await params;
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
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
        .eq("avatar_provider_video_job_id", providerJobId);
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
