import { isSubscriptionActive } from "./subscription";
import { getPlanByPriceId, PLAN_CONFIGS, type PlanConfig } from "./plans";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import type { createServiceClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type GenerationCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

type MinimalUser = { email?: string; email_confirmed_at?: string } | null | undefined;

/**
 * QA bypass EXCLUSIVO para la cuenta beta/admin allowlisted
 * (canPrepareAvatar, ver private-access.ts) — nunca decide nada para
 * ninguna otra cuenta. No hace a Starter "incluir avatar": solo le da a
 * ESA cuenta un piso mensual real (el mismo del plan Pro) en vez de un
 * límite "infinito" — el cost guard (conteo mensual más abajo) sigue
 * aplicando también para ella, evitando gasto real descontrolado durante
 * QA. NO toca Stripe, precios, ni el plan persistido del usuario.
 */
const BETA_QA_AVATAR_MONTHLY_LIMIT = PLAN_CONFIGS.pro.monthlyAvatarLimit;

/**
 * Límite mensual de avatar efectivo para este usuario — el del plan real,
 * salvo para la cuenta beta allowlisted en un plan que no incluye avatar
 * en absoluto, a la que se le sube a un piso de QA real (nunca se le baja
 * un límite ya incluido en su plan real).
 */
function resolveAvatarLimit(plan: PlanConfig, user: MinimalUser): number {
  if (plan.monthlyAvatarLimit > 0) return plan.monthlyAvatarLimit;
  return canPrepareAvatar(user ?? null) ? BETA_QA_AVATAR_MONTHLY_LIMIT : plan.monthlyAvatarLimit;
}

type PlanResolution =
  | { active: true; plan: PlanConfig }
  | { active: false; reason: string };

async function resolveActivePlan(service: ServiceClient, userId: string): Promise<PlanResolution> {
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
    return { active: false, reason: "Necesitas una suscripción activa para generar videos." };
  }

  // price_id sin coincidencia con ningún STRIPE_PRICE_ID_* configurado
  // (plan heredado, o variable de entorno todavía sin definir) cae al
  // plan más conservador en vez de bloquear o de permitir sin límite —
  // ver plans.ts.
  const plan = getPlanByPriceId(row?.price_id) ?? PLAN_CONFIGS.starter;
  return { active: true, plan };
}

/**
 * Comprobación LIGERA (sin la consulta de conteo mensual) usada solo para
 * decidir si la UI debe mostrar "Generar video final" habilitado o un
 * bloqueo — nunca la fuente de verdad que impide generar de verdad (esa
 * sigue siendo assertCanGenerate, ejecutada server-side en el momento del
 * envío). Evita una segunda consulta de conteo solo para pintar un botón.
 */
export async function avatarEntitlementPreview(
  service: ServiceClient,
  userId: string,
  user: MinimalUser,
): Promise<{ blocked: boolean; reason?: string }> {
  const resolution = await resolveActivePlan(service, userId);
  if (!resolution.active) return { blocked: true, reason: resolution.reason };
  const limit = resolveAvatarLimit(resolution.plan, user);
  if (limit <= 0) {
    return {
      blocked: true,
      reason: `Tu plan (${resolution.plan.name}) no incluye videos con avatar — mejora tu plan para desbloquearlo.`,
    };
  }
  return { blocked: false };
}

export async function assertCanGenerate(
  service: ServiceClient,
  userId: string,
  mode: string,
  /**
   * Usuario autenticado (con email/email_confirmed_at) — opcional para no
   * romper llamadas existentes. Solo se usa para el bypass de entitlement
   * de la cuenta beta allowlisted en modo avatar; sin él, el
   * comportamiento es exactamente el mismo que antes de este parámetro.
   */
  user?: MinimalUser,
): Promise<GenerationCheck> {
  const resolution = await resolveActivePlan(service, userId);
  if (!resolution.active) return { allowed: false, reason: resolution.reason };
  const { plan } = resolution;

  const isAvatar = mode === "avatar";
  const limit = isAvatar ? resolveAvatarLimit(plan, user) : plan.monthlyNormalLimit;

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
