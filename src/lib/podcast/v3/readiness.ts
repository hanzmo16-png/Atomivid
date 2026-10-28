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
