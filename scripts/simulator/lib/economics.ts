/**
 * Economía unitaria por video — SOLO consume los estimadores y tarifas que
 * ATOMIVID ya tiene (no hay un segundo sistema de precios):
 *   - src/lib/billing/pricing.ts        getPricingConfig / estimateTokensFromChars / estimateCostUsd
 *   - src/lib/video/long-form/cost.ts   estimateLongFormCost (estimador preventivo de Long Form)
 *   - src/lib/providers/avatar/heygen.ts estimateHeygenCost
 *   - src/lib/providers/avatar/did.ts    didAvatarProvider.estimateVideoCostUsd (y su tarifa por segundo)
 * Lo que no tiene estimador se marca "UNKNOWN" con su motivo; nunca se rellena.
 */
import { execFileSync } from "node:child_process";

export type CostLine = {
  provider: string;
  resource: string;
  quantity: number | "UNKNOWN";
  unit: string;
  rate: string;
  usd: number | "UNKNOWN";
  source: string;
  note?: string;
};

export type UnitEconomics = {
  actual_provider_spend_usd: 0;
  theoretical_cost_usd: number;
  theoretical_cost_is_lower_bound: boolean;
  label: "TEÓRICO — estimación con tarifas configuradas, no gasto real";
  breakdown: CostLine[];
  unknown_components: string[];
  rate_references: Record<string, { commit: string; date: string }>;
};

export function rateReference(file: string) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%h %cs", "--", file], { cwd: process.cwd() }).toString().trim();
    const [commit, date] = out.split(" ");
    return { commit, date };
  } catch {
    return { commit: "UNKNOWN", date: "UNKNOWN" };
  }
}

export function summarize(lines: CostLine[]): UnitEconomics {
  const known = lines.filter((l) => typeof l.usd === "number") as (CostLine & { usd: number })[];
  const unknown = lines.filter((l) => l.usd === "UNKNOWN");
  const files = [...new Set(lines.map((l) => l.source.split(" ")[0]).filter((f) => f.startsWith("src/")))];
  return {
    actual_provider_spend_usd: 0,
    theoretical_cost_usd: Math.round(known.reduce((s, l) => s + l.usd, 0) * 10000) / 10000,
    theoretical_cost_is_lower_bound: unknown.length > 0,
    label: "TEÓRICO — estimación con tarifas configuradas, no gasto real",
    breakdown: lines,
    unknown_components: unknown.map((l) => `${l.provider}/${l.resource}: ${l.note ?? "sin estimador"}`),
    rate_references: Object.fromEntries(files.map((f) => [f, rateReference(f)])),
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export async function reelEconomics(input: { scriptOutputChars: number; voiceCharactersSent: number; renderMs: number; musicTrack: boolean; footageCount: number }) {
  const { getPricingConfig, estimateTokensFromChars } = await import("../../../src/lib/billing/pricing");
  const p = getPricingConfig();
  const out = estimateTokensFromChars(0, input.scriptOutputChars).outputTokens;
  return summarize([
    { provider: "anthropic", resource: "guion — tokens de salida (estimados por caracteres)", quantity: out, unit: "tokens", rate: `$${p.scriptOutputUsdPer1MTokens}/1M`, usd: round((out / 1e6) * p.scriptOutputUsdPer1MTokens), source: "src/lib/billing/pricing.ts estimateTokensFromChars" },
    { provider: "anthropic", resource: "guion — tokens de entrada (prompt real)", quantity: "UNKNOWN", unit: "tokens", rate: `$${p.scriptInputUsdPer1MTokens}/1M`, usd: "UNKNOWN", source: "src/lib/billing/pricing.ts", note: "el guion del simulador es fixture: no se construyó el prompt real, su tamaño no se conoce" },
    { provider: "elevenlabs", resource: "TTS con timestamps (todas las síntesis, incl. corrección de velocidad)", quantity: input.voiceCharactersSent, unit: "caracteres", rate: `$${p.elevenLabsUsdPer1kChars}/1k`, usd: round((input.voiceCharactersSent / 1000) * p.elevenLabsUsdPer1kChars), source: "src/lib/billing/pricing.ts getPricingConfig" },
    { provider: "github-actions", resource: "minutos de render (medidos en este contenedor, no en el runner)", quantity: round(input.renderMs / 60000), unit: "min", rate: `$${p.renderUsdPerMinute}/min`, usd: round((input.renderMs / 60000) * p.renderUsdPerMinute), source: "src/lib/billing/pricing.ts getPricingConfig", note: "aproximación: el runner real puede tardar distinto" },
    { provider: "pexels", resource: "footage de stock", quantity: input.footageCount, unit: "clips", rate: "$0 (pricing.ts: gratis)", usd: 0, source: "src/lib/billing/pricing.ts (comentario de tarifas)" },
    { provider: "music-library", resource: "pista curada", quantity: input.musicTrack ? 1 : 0, unit: "pistas", rate: `$${p.musicUsdPerTrack}/pista`, usd: round((input.musicTrack ? 1 : 0) * p.musicUsdPerTrack), source: "src/lib/billing/pricing.ts getPricingConfig" },
    { provider: "supabase", resource: "almacenamiento y egreso del MP4", quantity: "UNKNOWN", unit: "GB", rate: "UNKNOWN", usd: "UNKNOWN", source: "src/lib/billing/pricing.ts", note: "pricing.ts cita la página de precios pero no define tarifa" },
  ]);
}

export async function avatarEconomics(input: { provider: "heygen" | "did"; audioSeconds: number; voiceCharacters: number; script: string; billablePosts: number }) {
  const { getPricingConfig } = await import("../../../src/lib/billing/pricing");
  const p = getPricingConfig();
  const lines: CostLine[] = [
    { provider: "elevenlabs", resource: "narración propia (TTS)", quantity: input.voiceCharacters, unit: "caracteres", rate: `$${p.elevenLabsUsdPer1kChars}/1k`, usd: round((input.voiceCharacters / 1000) * p.elevenLabsUsdPer1kChars), source: "src/lib/billing/pricing.ts getPricingConfig" },
  ];
  if (input.provider === "heygen") {
    const { estimateHeygenCost } = await import("../../../src/lib/providers/avatar/heygen");
    const perJob = estimateHeygenCost(input.audioSeconds);
    lines.push({ provider: "heygen", resource: "Avatar IV foto+audio (por trabajo aceptado)", quantity: input.billablePosts, unit: `trabajos de ${input.audioSeconds.toFixed(2)} s`, rate: "$0.0385/s (tarifa observada en la cuenta, redondeo al centavo)", usd: round(perJob * input.billablePosts), source: "src/lib/providers/avatar/heygen.ts estimateHeygenCost" });
  } else {
    const { didAvatarProvider } = await import("../../../src/lib/providers/avatar/did");
    const perSecond = Number(process.env.DID_COST_USD_PER_SECOND || "0.0983");
    lines.push({ provider: "d-id", resource: "talk con audio propio (por trabajo aceptado)", quantity: input.billablePosts, unit: `trabajos de ${input.audioSeconds.toFixed(2)} s`, rate: `$${perSecond}/s (agregadores de terceros, NO verificado con D-ID)`, usd: round(input.audioSeconds * perSecond * input.billablePosts), source: "src/lib/providers/avatar/did.ts COST_USD_PER_SECOND", note: `estimateVideoCostUsd(texto) daría $${didAvatarProvider.estimateVideoCostUsd({ script: input.script }).toFixed(4)} por palabras/2.5` });
  }
  lines.push({ provider: "supabase", resource: "almacenamiento del MP4 y la narración", quantity: "UNKNOWN", unit: "GB", rate: "UNKNOWN", usd: "UNKNOWN", source: "src/lib/billing/pricing.ts", note: "sin tarifa configurada" });
  return summarize(lines);
}

export async function youtubeEconomics(input: { durationSec: number; beats: { narration: string; shots: { type: string; source?: string }[] }[]; stockDownloads: number; productionRenderMs: number | null }) {
  const { estimateLongFormCost } = await import("../../../src/lib/video/long-form/cost");
  const { getPricingConfig } = await import("../../../src/lib/billing/pricing");
  const p = getPricingConfig();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const est = estimateLongFormCost({ durationSec: input.durationSec, beats: input.beats as any });
  const chars = input.beats.map((b) => b.narration).join(" ").length;
  const econ = summarize([
    { provider: "anthropic", resource: "guion/LLM (importe fijo del estimador Long Form)", quantity: 1, unit: "guion", rate: "$0.4 fijo (cost.ts llmUsd por defecto)", usd: est.llmUsd, source: "src/lib/video/long-form/cost.ts estimateLongFormCost" },
    { provider: "elevenlabs", resource: "TTS por beat", quantity: chars, unit: "caracteres", rate: "$0.3/1k (cost.ts ttsUsdPer1kChars por defecto)", usd: est.ttsUsd, source: "src/lib/video/long-form/cost.ts estimateLongFormCost", note: `pricing.ts usa $${p.elevenLabsUsdPer1kChars}/1k para la misma voz → $${((chars / 1000) * p.elevenLabsUsdPer1kChars).toFixed(4)}; dos estimadores existentes no coinciden` },
    { provider: "openai", resource: "imágenes IA (estrategia economical)", quantity: input.beats.flatMap((b) => b.shots).filter((s) => s.type === "generated_placeholder" || s.source === "generated").length, unit: "imágenes", rate: "$0.04 c/u (cost.ts)", usd: est.imageUsd, source: "src/lib/video/long-form/cost.ts estimateLongFormCost" },
    { provider: "pexels", resource: "stock (en simulación: sintético)", quantity: input.stockDownloads, unit: "descargas", rate: "$0 (pricing.ts: gratis)", usd: 0, source: "src/lib/billing/pricing.ts (comentario de tarifas)" },
    { provider: "github-actions", resource: "render 1080p de producción", quantity: input.productionRenderMs === null ? "UNKNOWN" : round(input.productionRenderMs / 60000), unit: "min", rate: `$${p.renderUsdPerMinute}/min`, usd: input.productionRenderMs === null ? "UNKNOWN" : round((input.productionRenderMs / 60000) * p.renderUsdPerMinute), source: "src/lib/billing/pricing.ts getPricingConfig", note: "solo se midió el render estructural 480x270; el tiempo a 1080p no se conoce" },
    { provider: "supabase", resource: "almacenamiento del MP4", quantity: "UNKNOWN", unit: "GB", rate: "UNKNOWN", usd: "UNKNOWN", source: "src/lib/billing/pricing.ts", note: "sin tarifa configurada" },
  ]);
  return { ...econ, long_form_estimator_output: est };
}
