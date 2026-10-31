import { createServiceClient } from "@/lib/supabase/service";
import { studioBetaUser, studioOwnerPilot } from "@/lib/podcast/v3/studio";
import { validStudioOwnerSignature } from "@/lib/podcast/v3/owner-check";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Generador → app: ¿esta cuenta es la del dueño con el piloto del estudio activo (`owner`)? ¿Es la cuenta interna del dueño
 * (`internalOwner`, el mismo criterio con el que la app ofrece Recraft)? ¿Es un cliente de la beta (`beta`)? Firmado (HMAC, clave de servicio); solo sí/no.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!validStudioOwnerSignature(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(), userId, request.headers.get("x-probe-nonce") ?? "", request.headers.get("x-probe-time"), request.headers.get("x-probe-signature")))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await createServiceClient().auth.admin.getUserById(userId);
  const user = data?.user ? { id: data.user.id, email_confirmed_at: data.user.email_confirmed_at ?? null } : null;
  return Response.json({ owner: studioOwnerPilot(user), beta: studioBetaUser(user), internalOwner: isInternalProductionOwner(user ? { id: user.id, email_confirmed_at: user.email_confirmed_at ?? undefined } : null) });
}
