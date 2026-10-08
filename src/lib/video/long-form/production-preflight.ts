/**
 * Pre-flight shown on Configure BEFORE the user starts, and enforced on the server (confirm + render).
 * Read-only: it computes the SAME demands and admission rule the start click uses (jobSupplyDemands +
 * ensureJobSupplyReady, without refreshing balances on page load) and the SAME visual release check the
 * worker runs (visualReleasePreflight). Nothing is reserved, charged or written.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { jobSupplyDemands } from "@/lib/supply/job";
import { ensureJobSupplyReady, type ProviderReadiness } from "@/lib/supply/readiness";
import { getLongFormBudget } from "./cost";
import { usesVisualIdentity } from "./production-plan-types";
import type { ProductionPlan, ProductionPlanBeatInput, VisualStrategy } from "./production-plan";
import { MAX_TEXT_FALLBACK_RATIO, visualReleasePreflight } from "./visual-release-preflight";

export type CapacityVerdict = "Suficiente" | "Insuficiente" | "Sin verificar";
export type ProviderCheck = {
  provider: string;
  label: string;
  verdict: CapacityVerdict;
  needUnits: number | null;
  unit: string;
  needUsd: number;
  freeUnits: number | null;
  /** Actionable, exact when computable: what to top up or what will happen at the click. */
  action: string | null;
  /** Latest balance observation: when, and whether the provider API or a manual entry reported it. */
  snapshotAt?: string | null;
  source?: "provider_api" | "manual_entry" | null;
  sourceLabel?: string | null;
  refreshError?: string | null;
};
export type VisualCheck = {
  applies: boolean;
  ready: boolean;
  codes: string[];
  missingHeroIdentities: number;
  missingHeroEvidence: number;
  textCardRatio: number | null;
  maxTextCardRatio: number;
  verifiedAssets: number;
};
export type StrategyPreflight = {
  strategy: VisualStrategy;
  estimatedUsd: number;
  limitUsd: number;
  withinLimit: boolean;
  providers: ProviderCheck[];
  capacityReady: boolean;
  globalNote: string | null;
};

const LABEL: Record<string, string> = { heygen: "HeyGen (avatar)", elevenlabs: "ElevenLabs (voz)", openai: "OpenAI (imágenes)", runway: "Runway (video IA)", veo: "Veo (video IA)", beatoven: "Beatoven (música)", anthropic: "Anthropic (guion)", bfl: "BFL (imágenes)", luma: "Luma (video IA)", ltx: "LTX (video IA)" };
const UNIT: Record<string, string> = { character: "caracteres", usd: "USD", credit: "créditos" };
const label = (p: string) => LABEL[p] ?? p;
const ceil2 = (n: number) => Math.ceil(n * 100) / 100;

/** Turns one readiness row into a user-facing verdict and an exact action. */
export function providerCheck(row: ProviderReadiness, unit: string): ProviderCheck {
  const base = { provider: row.provider, label: label(row.provider), needUnits: row.units, unit, needUsd: row.usd, freeUnits: row.free };
  if (row.ok) return { ...base, verdict: "Suficiente", action: null };
  const perUnitUsd = row.units && row.units > 0 ? row.usd / row.units : null;
  if (row.failure === "supplier balance unavailable" && row.level !== "UNKNOWN" && row.free !== null && row.units !== null) {
    const shortfall = Math.max(0, row.units - row.free);
    // USD-denominated balances: exact cents, never rounded to whole dollars.
    if (unit === "usd") return { ...base, verdict: "Insuficiente", action: `Recarga al menos ${ceil2(shortfall).toFixed(2)} USD en ${label(row.provider)}. Disponible: ${(Math.floor(row.free * 100) / 100).toFixed(2)} USD; necesario: ${ceil2(row.units).toFixed(2)} USD.` };
    const usd = perUnitUsd !== null ? ` (≈ ${ceil2(shortfall * perUnitUsd).toFixed(2)} USD)` : "";
    return { ...base, verdict: "Insuficiente", action: `Recarga al menos ${Math.ceil(shortfall).toLocaleString("es-MX")} ${UNIT[unit] ?? unit}${usd} en ${label(row.provider)}. Disponible: ${Math.floor(row.free).toLocaleString("es-MX")}; necesario: ${Math.ceil(row.units).toLocaleString("es-MX")}.` };
  }
  if (row.failure === "supplier balance unavailable" && row.level === "RED") {
    return { ...base, verdict: "Insuficiente", action: `El saldo de ${label(row.provider)} está en rojo. Recarga la cuenta del proveedor antes de iniciar.` };
  }
  if (row.failure === "provider funded spend ceiling") {
    return { ...base, verdict: "Insuficiente", action: `Se alcanzaría el tope de gasto diario o mensual configurado para ${label(row.provider)} (${row.usd.toFixed(2)} USD necesarios). Espera al siguiente periodo o ajusta el tope.` };
  }
  if (row.failure === "supplier unconfigured" || row.failure === "invalid demand") {
    return { ...base, verdict: "Insuficiente", action: `${label(row.provider)} no tiene una política de suministro válida configurada; la producción no puede iniciar.` };
  }
  return { ...base, verdict: "Sin verificar", action: `El saldo de ${label(row.provider)} no está verificado ahora. Se consulta al proveedor al iniciar (sin generar nada); si no se confirma, no se inicia ni se cobra.` };
}

/** Latest capacity snapshot per provider (time + source), read-only. */
export async function latestSnapshots(service: SupabaseClient, providers: string[]): Promise<Map<string, { checkedAt: string; reliability: string; health: string | null }>> {
  const out = new Map<string, { checkedAt: string; reliability: string; health: string | null }>();
  for (const provider of providers) {
    const { data } = await service.from("pi_capacity_snapshots").select("checked_at,reliability,health").eq("provider", provider).order("checked_at", { ascending: false }).limit(1).maybeSingle();
    if (data) out.set(provider, { checkedAt: data.checked_at, reliability: data.reliability, health: data.health ?? null });
  }
  return out;
}

export function sourceLabel(reliability: string | null | undefined): string | null {
  if (reliability === "provider_api") return "consultado al proveedor";
  if (reliability === "manual_entry") return "saldo registrado manualmente (no consultado al proveedor)";
  return reliability ? reliability : null;
}

export async function strategyPreflight(service: SupabaseClient, input: { strategy: VisualStrategy; plan: ProductionPlan; scriptJson: unknown; env?: Record<string, string | undefined>; refreshErrors?: Record<string, string> }): Promise<StrategyPreflight> {
  const limitUsd = getLongFormBudget(input.env).maxTotalUsd;
  const out: StrategyPreflight = { strategy: input.strategy, estimatedUsd: input.plan.estimatedProviderCostUsd, limitUsd, withinLimit: input.plan.estimatedProviderCostUsd <= limitUsd, providers: [], capacityReady: false, globalNote: null };
  try {
    const demands = jobSupplyDemands({ mode: "long_form", script_json: input.scriptJson, recorded_audio_path: null, long_form_production_plan: input.plan }, input.plan.providers.voice);
    const readiness = await ensureJobSupplyReady(service, demands, { refresh: false });
    const snaps = await latestSnapshots(service, readiness.providers.map((r) => r.provider)).catch(() => new Map());
    out.providers = readiness.providers.map((r) => {
      const snap = snaps.get(r.provider);
      return { ...providerCheck(r, demands.find((d) => d.provider === r.provider)?.unit ?? "usd"),
        snapshotAt: snap?.checkedAt ?? null, source: (snap?.reliability as ProviderCheck["source"]) ?? null, sourceLabel: sourceLabel(snap?.reliability), refreshError: input.refreshErrors?.[r.provider] ?? null };
    });
    out.capacityReady = readiness.ready;
    if (!readiness.ready && readiness.failure?.provider === "production") {
      out.globalNote = readiness.failure.reason === "global funded spend ceiling"
        ? "Se alcanzaría el tope global de gasto diario o mensual. Espera al siguiente periodo o ajusta el tope global."
        : "El presupuesto global de producción no está configurado o no se pudo leer; la producción no puede iniciar.";
    }
  } catch {
    out.globalNote = "No se pudo calcular la capacidad de los proveedores ahora. Se comprobará al iniciar; si no se confirma, no se inicia ni se cobra.";
  }
  return out;
}

const shortCode = (b: string) => b.replace(/^HERO_COVERAGE\s+/, "").split(":")[0].trim();

/** Visual verdict of v4+ plans; identical to the worker's pre-spend gate. */
export async function visualCheck(service: SupabaseClient, input: { requestId: string; plan: ProductionPlan; beats: ProductionPlanBeatInput[]; topic: string }): Promise<VisualCheck> {
  if (!usesVisualIdentity(input.plan)) return { applies: false, ready: true, codes: [], missingHeroIdentities: 0, missingHeroEvidence: 0, textCardRatio: null, maxTextCardRatio: MAX_TEXT_FALLBACK_RATIO, verifiedAssets: 0 };
  const pre = await visualReleasePreflight({ supabase: service, ...input });
  return {
    applies: true,
    ready: pre.blockers.length === 0,
    codes: [...new Set(pre.blockers.map(shortCode))],
    missingHeroIdentities: pre.coverage?.heroMissingRequiredIdentities.length ?? 0,
    missingHeroEvidence: pre.coverage?.heroMissingRequiredEvidence.length ?? 0,
    textCardRatio: pre.coverage?.estimatedTextCardRatio ?? null,
    maxTextCardRatio: MAX_TEXT_FALLBACK_RATIO,
    verifiedAssets: pre.verifiedAssets.size,
  };
}

/** One user-facing sentence for a visual block (used by the server guards and the page). */
export function visualBlockMessage(v: VisualCheck): string {
  const parts: string[] = [];
  if (v.missingHeroIdentities) parts.push(`${v.missingHeroIdentities} identidad(es) de la apertura sin material verificado`);
  if (v.missingHeroEvidence) parts.push(`${v.missingHeroEvidence} prueba(s) de la apertura sin material verificado`);
  if (v.textCardRatio !== null && v.textCardRatio > v.maxTextCardRatio) parts.push(`${Math.round(v.textCardRatio * 100)} % de escenas acabarían en tarjeta de texto (máximo ${Math.round(v.maxTextCardRatio * 100)} %)`);
  if (v.codes.includes("OPENING_TEXT_CARD_RUN")) parts.push("3 o más tarjetas seguidas en los primeros 30 s");
  const detail = parts.length ? parts.join("; ") : v.codes.join(", ");
  return `Esta producción no puede iniciar todavía: ${detail}. Falta curar material verificado; no se confirmó, reservó ni cobró nada.`;
}
