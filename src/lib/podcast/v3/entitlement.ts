/**
 * Podcast Studio para clientes (beta): derecho del plan y control de gasto, decidido en el SERVIDOR antes de autorizar.
 *
 * - El dueño (piloto) no cambia: sus topes siguen siendo el presupuesto del episodio y STUDIO_MAX_AUTHORIZED_USD.
 * - Un cliente beta necesita una suscripción activa y que su plan tenga límites configurados en
 *   PODCAST_STUDIO_PLAN_LIMITS (JSON, p. ej. {"pro":{"episode_usd":5,"month_usd":20}}). Sin configuración = sin derecho:
 *   aquí no se inventan precios ni cuotas.
 * - El consumo del mes se calcula con los propios episodios del cliente (sin tablas nuevas):
 *   listo → costo real (o lo autorizado si aún no hay costo); autorizado/generándose → lo autorizado (reservado);
 *   con error → 0 (devolución: un fallo no consume el derecho del cliente); borrador → 0.
 * - El límite mensual se comprueba antes de autorizar y otra vez después (dos autorizaciones simultáneas no pueden
 *   pasar del límite: la segunda se revierte a borrador antes de despachar nada).
 */
import { isSubscriptionActive } from "@/lib/billing/subscription";
import { getPlanByPriceId, PLAN_CONFIGS, type PlanId } from "@/lib/billing/plans";

type Env = Record<string, string | undefined>;
export type StudioPlanLimits = { episode_usd: number; month_usd: number };
export type StudioLimits = Partial<Record<PlanId, StudioPlanLimits>>;
export type AllowanceRow = { status: string; authorized_usd: number | string | null; cost_usd: number | string | null; created_at: string };
export type SpendDecision = { ok: true } | { ok: false; status: 402 | 403; error: string };

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const money = (n: number) => `USD ${n.toFixed(2)}`;

/** Límites por plan desde la configuración. JSON inválido o valores no positivos: ese plan queda sin derecho (fail closed). */
export function parseStudioLimits(env: Env = process.env): StudioLimits {
  let raw: unknown;
  try { raw = JSON.parse(env.PODCAST_STUDIO_PLAN_LIMITS ?? "{}"); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StudioLimits = {};
  for (const id of Object.keys(PLAN_CONFIGS) as PlanId[]) {
    const v = (raw as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    const episode = num(v?.episode_usd), month = num(v?.month_usd);
    if (Number.isFinite(episode) && Number.isFinite(month) && episode > 0 && month >= episode) out[id] = { episode_usd: episode, month_usd: month };
  }
  return out;
}

/** Primer instante del mes natural (UTC) de `now`. */
export const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

/** Consumo del mes del cliente según el estado de sus episodios (ver cabecera). */
export function allowanceUsed(rows: AllowanceRow[], monthStartIso: string): number {
  let used = 0;
  for (const r of rows) {
    if (Date.parse(r.created_at) < Date.parse(monthStartIso)) continue;
    const auth = num(r.authorized_usd), cost = num(r.cost_usd);
    if (r.status === "ready") used += Number.isFinite(cost) ? cost : Number.isFinite(auth) ? auth : 0;
    else if (r.status === "authorized" || r.status === "generating") used += Number.isFinite(auth) ? auth : 0;
  }
  return Math.round(used * 1e4) / 1e4;
}

/** Decisión pura para un cliente beta (el dueño no pasa por aquí). `usd` = lo que se quiere autorizar (0 = solo comprobar). */
export function studioSpendDecision(i: { subscriptionStatus: string | null; plan: PlanId | null; limits: StudioLimits; usd: number; used: number }): SpendDecision {
  if (!isSubscriptionActive(i.subscriptionStatus)) return { ok: false, status: 403, error: "Necesitas una suscripción activa para crear episodios de Podcast Studio." };
  const lim = i.plan ? i.limits[i.plan] : undefined;
  if (!lim) return { ok: false, status: 403, error: "Tu plan todavía no incluye Podcast Studio." };
  if (i.usd > lim.episode_usd + 1e-9) return { ok: false, status: 402, error: `Este episodio (${money(i.usd)}) supera el máximo por episodio de tu plan (${money(lim.episode_usd)}). Acórtalo o elige «Solo estudio y anfitriones».` };
  if (i.used + i.usd > lim.month_usd + 1e-9) {
    const left = Math.max(0, lim.month_usd - i.used);
    return { ok: false, status: 402, error: `No te alcanza el saldo del mes: te quedan ${money(left)} de ${money(lim.month_usd)}. Se renueva el día 1.` };
  }
  return { ok: true };
}

type Db = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Comprobación con datos reales del cliente (solo lectura). `after` = tras el CAS de autorización: el episodio ya cuenta
 * como reservado y solo se verifica que el total no pase del límite.
 */
export async function checkStudioSpend(db: Db, userId: string, usd: number, env: Env = process.env, now = new Date(), after = false): Promise<SpendDecision> {
  const sub = await db.from("subscriptions").select("status, price_id").eq("user_id", userId).maybeSingle();
  if (sub.error) return { ok: false, status: 403, error: "No se pudo comprobar tu suscripción; inténtalo de nuevo." };
  const row = sub.data as { status: string | null; price_id: string | null } | null;
  const plan = getPlanByPriceId(row?.price_id)?.id ?? (isSubscriptionActive(row?.status) ? "starter" : null);
  const start = monthStartUtc(now);
  const eps = await db.from("podcast_studio_episodes").select("status,authorized_usd,cost_usd,created_at").eq("user_id", userId).gte("created_at", start);
  if (eps.error) return { ok: false, status: 403, error: "No se pudo comprobar tu saldo; inténtalo de nuevo." };
  const used = allowanceUsed((eps.data ?? []) as AllowanceRow[], start);
  return studioSpendDecision({ subscriptionStatus: row?.status ?? null, plan, limits: parseStudioLimits(env), usd: after ? 0 : usd, used });
}
