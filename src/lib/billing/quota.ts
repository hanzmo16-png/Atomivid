import { isSubscriptionActive } from "./subscription";
import type { createServiceClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Tope de videos por mes incluso para suscriptores activos: protege los
// costos variables (LLM, voz, render) mientras se valida la demanda.
// Configurable por env var — ver notas de presupuesto en el README.
const MONTHLY_VIDEO_LIMIT = Number(process.env.MONTHLY_VIDEO_LIMIT || 30);

export type GenerationCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function assertCanGenerate(
  service: ServiceClient,
  userId: string,
): Promise<GenerationCheck> {
  const { data } = await service
    .from("subscriptions")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();

  const status = (data as { status: string } | null)?.status ?? "none";

  if (!isSubscriptionActive(status)) {
    return {
      allowed: false,
      reason: "Necesitas una suscripción activa para generar videos.",
    };
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count } = await service
    .from("video_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["processing", "completed"])
    .gte("created_at", startOfMonth.toISOString());

  if ((count ?? 0) >= MONTHLY_VIDEO_LIMIT) {
    return {
      allowed: false,
      reason: `Alcanzaste el límite de ${MONTHLY_VIDEO_LIMIT} videos este mes. Vuelve a intentarlo el próximo mes.`,
    };
  }

  return { allowed: true };
}
