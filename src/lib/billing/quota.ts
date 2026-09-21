import { isSubscriptionActive } from "./subscription";
import { getPlanByPriceId, PLAN_CONFIGS } from "./plans";
import type { createServiceClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type GenerationCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function assertCanGenerate(
  service: ServiceClient,
  userId: string,
  mode: string,
): Promise<GenerationCheck> {
  const { data, error: subError } = await service
    .from("subscriptions")
    .select("status, price_id")
    .eq("user_id", userId)
    .maybeSingle();
  // Un error real de Supabase aquí (no "sin fila") no debe tratarse como
  // "sin suscripción" — eso le mostraría al usuario un mensaje de compra
  // engañoso cuando el problema real es de conexión con la base de datos.
  // Se relanza para que el llamador (route.ts) lo clasifique como fallo de
  // la etapa "check_subscription", no como una decisión de negocio válida.
  if (subError) throw subError;

  const row = data as { status: string; price_id: string | null } | null;
  const status = row?.status ?? "none";

  if (!isSubscriptionActive(status)) {
    return {
      allowed: false,
      reason: "Necesitas una suscripción activa para generar videos.",
    };
  }

  // price_id sin coincidencia con ningún STRIPE_PRICE_ID_* configurado
  // (plan heredado, o variable de entorno todavía sin definir) cae al
  // plan más conservador en vez de bloquear o de permitir sin límite —
  // ver plans.ts.
  const plan = getPlanByPriceId(row?.price_id) ?? PLAN_CONFIGS.starter;
  const isAvatar = mode === "avatar";
  const limit = isAvatar ? plan.monthlyAvatarLimit : plan.monthlyNormalLimit;

  if (limit <= 0) {
    return {
      allowed: false,
      reason: `Tu plan (${plan.name}) no incluye videos con avatar — mejora tu plan para desbloquearlo.`,
    };
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  let countQuery = service
    .from("video_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["processing", "completed"])
    .gte("created_at", startOfMonth.toISOString());

  // "hybrid" (mode en video_requests admite 'visual'/'avatar'/'hybrid' —
  // ver migración 0011) todavía no está implementado; cuando exista, su
  // costo real decidirá a qué cuota debe sumar — hoy cae en "normal" por
  // ser distinto de 'avatar', no por una decisión deliberada.
  countQuery = isAvatar ? countQuery.eq("mode", "avatar") : countQuery.neq("mode", "avatar");

  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  if ((count ?? 0) >= limit) {
    return {
      allowed: false,
      reason: `Alcanzaste el límite de ${limit} videos ${isAvatar ? "con avatar " : ""}este mes en tu plan (${plan.name}). Vuelve a intentarlo el próximo mes o mejora tu plan.`,
    };
  }

  return { allowed: true };
}
