/**
 * Podcast 3.0 — verificación previa de proveedores con la MISMA regla de producción que el resto de Atomicvid
 * (`ensureJobSupplyReady`: saldo verificado del proveedor, tope diario/mensual por proveedor y tope global).
 * Si un proveedor que el episodio necesita no está listo, no se empieza: ningún cargo.
 *
 * El estudio paga con su propio libro (podcast_studio_operations), que `pi_supply_spend` no ve. Para que los topes
 * diarios/globales sí cuenten lo que el estudio ya gastó, la demanda de cada proveedor incluye lo gastado por el
 * estudio en las últimas 24 h (conservador: puede rechazar de más, nunca de menos en el día).
 */
import type { JobSupplyDemand } from "@/lib/supply/job";
import type { ProviderNeeds } from "./pipeline";

export type StudioSpend24h = { elevenlabs?: number; heygen?: number; recraft?: number };
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function studioSupplyDemands(needs: ProviderNeeds, spent: StudioSpend24h): JobSupplyDemand[] {
  const out: JobSupplyDemand[] = [];
  const calls = (n: number | undefined) => (n !== undefined && n > 0 ? { calls: n } : {});
  if (needs.ttsChars > 0) out.push({ provider: "elevenlabs", unit: "character", units: needs.ttsChars, usd: r4(Math.max(needs.ttsUsd, 0.0001) + (spent.elevenlabs ?? 0)), ...calls(needs.ttsCalls) });
  if (needs.avatarUsd > 0) out.push({ provider: "heygen", unit: "usd", units: r4(needs.avatarUsd + (spent.heygen ?? 0)), usd: r4(needs.avatarUsd + (spent.heygen ?? 0)), ...calls(needs.avatarCalls) });
  // Ilustraciones (Recraft vía fal.ai): saldo verificado, topes diarios/mensuales y cuota de llamadas, como el resto.
  if (needs.imagesUsd > 0) out.push({ provider: "recraft", unit: "usd", units: r4(needs.imagesUsd + (spent.recraft ?? 0)), usd: r4(needs.imagesUsd + (spent.recraft ?? 0)), ...calls(needs.imagesCalls) });
  return out;
}

/** Gasto de imágenes sin generador conectado (p. ej. la estimación pide ilustraciones y no hay adaptador): se bloquea. */
export function unsupportedSpend(needs: ProviderNeeds, hasGenerator = true): string | null {
  return needs.imagesUsd > 0 && !hasGenerator ? "Ilustraciones de pago: el generador de imágenes del estudio no está conectado." : null;
}

/** Suma lo comprometido por el estudio (liquidado al costo real; reservado/incierto al reservado) por proveedor. */
export function studioSpendByProvider(rows: { provider: string; state: string; reserved_usd: number | string; actual_usd: number | string | null }[]): StudioSpend24h {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.state === "released") continue;
    const usd = r.state === "settled" ? Number(r.actual_usd ?? r.reserved_usd) : Number(r.reserved_usd);
    if (Number.isFinite(usd)) out[r.provider] = r4((out[r.provider] ?? 0) + usd);
  }
  return out as StudioSpend24h;
}

/**
 * ¿Puede Recraft producir hoy? Misma regla que Long Form (recraftProductionBlocker: política configurada y activada,
 * saldo de fal.ai verificable, no en rojo). Solo lectura. Un error al consultar también bloquea (falla cerrado).
 */
export async function studioRecraftBlocker(service: Pick<import("@supabase/supabase-js").SupabaseClient, "rpc">, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const { recraftProductionBlocker } = await import("@/lib/video/long-form/recraft-readiness");
  try { return await recraftProductionBlocker(service, env); } catch { return "no se pudo comprobar el estado de Recraft"; }
}

const PROVIDER_NAME: Record<string, string> = { elevenlabs: "ElevenLabs (voz)", heygen: "HeyGen (avatar)", recraft: "Recraft (ilustraciones)", production: "Atomicvid" };
const REASON: Record<string, string> = {
  "supplier balance unavailable": "no se pudo verificar un saldo suficiente",
  "supplier unconfigured": "no tiene límites de gasto configurados",
  "daily request quota": "alcanzó su cuota diaria de llamadas",
  "daily request quota unavailable": "no se pudo leer su cuota diaria",
  "provider funded spend ceiling": "alcanzaría su tope de gasto diario o mensual",
  "spend unavailable": "no se pudo leer el gasto acumulado",
  "global funded spend ceiling": "se alcanzaría el tope de gasto global diario o mensual",
  "funded global budget unconfigured": "el presupuesto global no está configurado",
  "supply policies unavailable": "no se pudieron leer las políticas de gasto",
};
/** Motivo de bloqueo previo legible (ProviderNotReadyError lo guarda en el episodio y se ve en «Tus episodios»). */
export function readinessMessage(failure: { provider: string; reason: string; quota?: { max: number; today: number; calls: number; timezone: string } } | undefined): string {
  const who = PROVIDER_NAME[failure?.provider ?? ""] ?? failure?.provider ?? "un proveedor";
  // Cuota diaria de llamadas de ATOMIVID (pi_supply_policies.max_daily_calls), no un error del proveedor. Con los números se
  // distingue si esperar sirve (cabe mañana) o no (el episodio necesita más llamadas de las que el límite permite en un día).
  const q = failure?.reason === "daily request quota" ? failure.quota : undefined;
  if (q) {
    const zone = q.timezone === "America/Cancun" ? "Cancún" : q.timezone;
    if (q.calls > q.max) return `${who}: este episodio necesita ${q.calls} llamadas y el límite diario de la plataforma es ${q.max}; no cabe en un día aunque se espere. Reduce las apariciones del avatar (menos planos con avatar o un episodio más corto) o pide al operador que revise ese límite.`;
    return `${who}: hoy ya se usaron ${q.today} de las ${q.max} llamadas diarias de la plataforma y este episodio necesita ${q.calls}; el límite se restablece a las 00:00 hora de ${zone}.`;
  }
  const why = REASON[failure?.reason ?? ""] ?? failure?.reason ?? "no está disponible";
  return `${who}: ${why}.`;
}

/**
 * Verificación previa al INICIO (API, antes de autorizar y despachar): la misma regla que aplica el worker (incluido
 * el refresco gratuito de un saldo no verificado). Nunca llama a generación ni cobra. Incidente 4290175a (2026-11-08): el
 * episodio necesitaba 48 llamadas de HeyGen sobre el límite diario de la plataforma y solo el runner lo descubría,
 * con el episodio ya «autorizado» y la persona viendo 0 %. Lanza si no se puede leer el gasto del estudio (falla cerrado).
 */
export async function studioSupplyCheck(service: import("@supabase/supabase-js").SupabaseClient, needs: ProviderNeeds, now: () => number = Date.now) {
  const { ensureJobSupplyReady } = await import("@/lib/supply/readiness");
  const { data: recent, error } = await service.from("podcast_studio_operations").select("provider,state,reserved_usd,actual_usd").gte("created_at", new Date(now() - 24 * 3600_000).toISOString());
  if (error) throw new Error("STUDIO_SPEND_UNAVAILABLE");
  const blocked = unsupportedSpend(needs, true);
  if (blocked) return { ready: false, providers: [], failure: { provider: "recraft", reason: blocked } };
  const demands = studioSupplyDemands(needs, studioSpendByProvider(recent ?? []));
  if (!demands.length) return { ready: true, providers: [] };
  // Misma regla que el worker: una lectura de saldo no verificada se refresca (GET de facturación gratuito); sin
  // refrescar, un saldo viejo bloquearía de más a quien sí puede producir. RED sigue RED.
  return ensureJobSupplyReady(service, demands, { now });
}

/**
 * Arnés E2E local con proveedores simulados (PODCAST_V3_PROVIDERS=mock fuera de producción): el worker simulado no
 * verifica suministro, y la API tampoco (misma regla). En producción (Vercel / NODE_ENV=production) nunca es cierto.
 */
export function studioProvidersSimulated(env: Record<string, string | undefined> = process.env): boolean {
  const production = env.NODE_ENV === "production" || env.VERCEL === "1" || env.ATOMIVID_RUNTIME === "production";
  return env.PODCAST_V3_PROVIDERS === "mock" && !production;
}

/** ¿Se aplica la verificación previa en la API? Siempre fuera del arnés simulado; en el arnés, solo si el ensayo la
 *  activa expresamente (PODCAST_V3_SUPPLY_GATE=1) para probar el bloqueo y la adaptación contra la base local. */
export function studioSupplyGateOn(env: Record<string, string | undefined> = process.env): boolean {
  return !studioProvidersSimulated(env) || env.PODCAST_V3_SUPPLY_GATE === "1";
}
