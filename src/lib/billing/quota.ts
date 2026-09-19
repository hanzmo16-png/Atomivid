import { monthlyVideoLimit, monthStartUtc } from "./quota-window";
import { isSubscriptionActive } from "./subscription";
import type { createServiceClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Tope de videos por mes incluso para suscriptores activos: protege los
// costos variables (LLM, voz, render) mientras se valida la demanda.
// Configurable por env var — ver notas de presupuesto en el README.


export type GenerationCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function assertCanGenerate(
  service: ServiceClient,
  userId: string,
): Promise<GenerationCheck> {
  const { data, error: subError } = await service
    .from("subscriptions")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  // Un error real de Supabase aquí (no "sin fila") no debe tratarse como
  // "sin suscripción" — eso le mostraría al usuario un mensaje de compra
  // engañoso cuando el problema real es de conexión con la base de datos.
  // Se relanza para que el llamador (route.ts) lo clasifique como fallo de
  // la etapa "check_subscription", no como una decisión de negocio válida.
  if (subError) throw subError;

  const status = (data as { status: string } | null)?.status ?? "none";

  if (!isSubscriptionActive(status)) {
    return {
      allowed: false,
      reason: "Necesitas una suscripción activa para generar videos.",
    };
  }

  const MONTHLY_VIDEO_LIMIT = monthlyVideoLimit();

  const { count, error: countError } = await service
    .from("video_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["processing", "completed"])
    .gte("created_at", monthStartUtc());
  if (countError) throw countError;

  if ((count ?? 0) >= MONTHLY_VIDEO_LIMIT) {
    return {
      allowed: false,
      reason: `Alcanzaste el límite de ${MONTHLY_VIDEO_LIMIT} videos este mes. Vuelve a intentarlo el próximo mes.`,
    };
  }

  return { allowed: true };
}
