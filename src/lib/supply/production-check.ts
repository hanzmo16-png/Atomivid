/**
 * «¿Puede Atomicvid hacer esta producción?» — answered on the server BEFORE the first paid call
 * (the script) and again before the render with the real script. It reuses the existing controls and
 * adds none of its own:
 *   - customer rights: assertCanGenerate (plan, monthly quota, owner internal production);
 *   - Atomivid's providers: ensureJobSupplyReady (pi_supply_state balances with their freshness rule,
 *     provider and global day/month ceilings, unreserved capacity), the same rule pi_reserve_job_supply
 *     and pi_submit_with_supply enforce atomically later;
 *   - demands: jobSupplyDemands (the render envelope) plus the script calls, sized with the same
 *     reservation formula the ledger uses (anthropicReservation).
 * It never reserves, never calls a generative provider and never treats an unknown price, balance or
 * configuration as zero, unlimited or authorised: anything not provable is reported as such and the
 * production does not start. The estimate is a conservative CEILING, never a quote.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCanGenerate } from "@/lib/billing/quota";
import { getPricingConfig, scriptPricingIssues } from "@/lib/billing/pricing";
import { scriptCallParamsFor } from "@/lib/ai/script";
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";
import { targetWordsFor } from "@/lib/video/script-pacing";
import { anthropicReservation, ceilLedgerUsd } from "./anthropic-cost";
import { jobSupplyDemands, type JobSupplyDemand, type SupplyJobInput } from "./job";
import { SupplyUnavailableError } from "./policy";
import { ensureJobSupplyReady, type ProviderReadiness, type SupplyReadiness } from "./readiness";
import { supplyGuardRequired } from "./server";
import type { ScriptLanguage } from "@/lib/providers/types";

/** The five answers the owner asked for, in order of who has to act. */
export type CheckOutcome = "ready" | "customer_limit" | "provider_unavailable" | "unverifiable" | "needs_correction";
export type Responsible = "nadie" | "cliente" | "atomicvid";
export type EstimateLine = { provider: string; unit: "usd" | "character"; units: number; usd: number; basis: string };
export type ProductionEstimate = {
  stage: "before_script" | "before_render";
  lines: EstimateLine[];
  /** Sum of the USD ceilings. A conservative upper bound for planning, not the price charged. */
  ceilingUsd: number;
  note: string;
};
export type CheckIssue = { outcome: Exclude<CheckOutcome, "ready">; responsible: Responsible; provider?: string; reason: string };
export type ProductionCheck = {
  outcome: CheckOutcome;
  responsible: Responsible;
  /** One short sentence: what is happening. */
  title: string;
  /** What it means and that nothing was spent. */
  message: string;
  /** The next step, for the person who can take it. */
  next: string;
  estimate: ProductionEstimate | null;
  issues: CheckIssue[];
  providers: ProviderReadiness[];
  /** Whether the supply controls ran (they are mandatory in production; locally they are opt-in). */
  supplyChecked: boolean;
  checkedAt: string;
  /** Voice provider the demands were sized for (the same getter the pipeline uses). */
  voiceProvider: string | null;
};

export type CheckRequest = {
  mode: string | null;
  duration_seconds: number;
  language?: ScriptLanguage | null;
  topic?: string | null;
  style?: string | null;
  recorded_audio_path: string | null;
  script_json: unknown;
  long_form_production_plan?: SupplyJobInput["long_form_production_plan"];
};

/**
 * Narration characters per word, as an upper bound (Spanish/English running text averages ~6 with the
 * space and punctuation; 8 leaves room for long words and numbers written out). Only used BEFORE the
 * script exists; after it, the real text length is used.
 */
export const NARRATION_CHARS_PER_WORD_CEILING = 8;
/** checkScriptQuality accepts at most 110 % of the target words (script-quality.ts). */
const MAX_ACCEPTED_WORD_RATIO = 1.1;

export function narrationCharsCeiling(durationSeconds: number): number {
  return Math.ceil(Math.floor(targetWordsFor(durationSeconds) * MAX_ACCEPTED_WORD_RATIO) * NARRATION_CHARS_PER_WORD_CEILING);
}

/** USD ceiling of every call a script generation may make, with the ledger's own reservation formula. */
export function scriptGenerationCeilingUsd(input: { topic: string; style: string; durationSeconds: number; language?: ScriptLanguage | null }): number {
  const pricing = getPricingConfig();
  const rates = { scriptInputUsdPer1MTokens: pricing.scriptInputUsdPer1MTokens, scriptOutputUsdPer1MTokens: pricing.scriptOutputUsdPer1MTokens };
  return scriptCallParamsFor({ topic: input.topic, style: input.style, durationSeconds: input.durationSeconds, language: input.language === "en" ? "en" : "es" })
    .reduce((sum, params) => sum + ceilLedgerUsd(anthropicReservation(params as Parameters<typeof anthropicReservation>[0], rates)), 0);
}

function basisFor(provider: string, stage: ProductionEstimate["stage"], unit: string): string {
  if (provider === "anthropic") return stage === "before_script" ? "guion (hasta 3 intentos de longitud) y, si está activo, el director visual" : "director visual del guion real";
  if (unit === "character") return stage === "before_script" ? "voz: palabras máximas aceptadas para la duración × 8 caracteres × 2 (una corrección de ritmo)" : "voz: caracteres reales del guion × corrección de ritmo";
  return "techo configurado por producción para este proveedor";
}

/**
 * Demands for this production at this stage. Before the script there is no text: the narration is sized
 * from the duration with the ceilings above and the script calls are added. Throws SupplyUnavailableError
 * (reason "job cost unverified" / "empty narration") exactly like jobSupplyDemands when a cost cannot be
 * proven.
 */
export function productionDemands(row: CheckRequest, voiceProvider: string, stage: ProductionEstimate["stage"], opts: {
  flags?: FeatureFlags; scriptProvider?: string;
} = {}): { demands: JobSupplyDemand[]; lines: EstimateLine[] } {
  const flags = opts.flags ?? getFeatureFlags();
  const mode = row.mode ?? "visual";
  const scriptSource = stage === "before_script" && mode !== "long_form"
    ? { segments: [{ text: "x".repeat(Math.max(1, narrationCharsCeiling(row.duration_seconds))) }] }
    : row.script_json;
  // jobSupplyDemands doubles Reel narration for the pacing correction; the synthetic text keeps that rule.
  const base = jobSupplyDemands({ mode, script_json: scriptSource, recorded_audio_path: row.recorded_audio_path,
    long_form_production_plan: row.long_form_production_plan ?? null }, voiceProvider, flags);
  const demands = new Map(base.map(d => [d.provider, { ...d }]));
  if (stage === "before_script" && mode !== "long_form" && !row.recorded_audio_path && (opts.scriptProvider ?? "anthropic") === "anthropic") {
    const usd = scriptGenerationCeilingUsd({ topic: row.topic ?? "", style: row.style ?? "", durationSeconds: row.duration_seconds, language: row.language });
    if (!Number.isFinite(usd) || !(usd > 0)) throw new SupplyUnavailableError("anthropic", "job cost unverified");
    const prev = demands.get("anthropic");
    demands.set("anthropic", { provider: "anthropic", unit: "usd", units: usd + (prev?.units ?? 0), usd: usd + (prev?.usd ?? 0) });
  }
  const list = [...demands.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  return { demands: list, lines: list.map(d => ({ ...d, basis: basisFor(d.provider, stage, d.unit) })) };
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "el servicio de guiones", elevenlabs: "el servicio de voz", heygen: "el servicio de avatar", did: "el servicio de avatar",
  openai: "el servicio de imágenes", beatoven: "el servicio de música", runway: "el servicio de clips de video", veo: "el servicio de clips de video",
  kling: "el servicio de clips de video", production: "el presupuesto de producción de Atomicvid",
};
const label = (p?: string) => (p && PROVIDER_LABEL[p]) || "un proveedor de Atomicvid";

/** Classifies one readiness failure into who must act. Unknown reasons fall back to «unverifiable». */
export function classifyReadiness(r: SupplyReadiness): CheckIssue | null {
  if (r.ready) return null;
  const f = r.failure ?? { provider: "production", reason: "unavailable" };
  const row = r.providers.find(p => p.provider === f.provider);
  switch (f.reason) {
    case "supplier unconfigured":
    case "funded global budget unconfigured":
    case "invalid demand":
      return { outcome: "needs_correction", responsible: "atomicvid", provider: f.provider, reason: f.reason };
    case "provider funded spend ceiling":
    case "global funded spend ceiling":
      return { outcome: "provider_unavailable", responsible: "atomicvid", provider: f.provider, reason: f.reason };
    case "supplier balance unavailable":
      if (row && row.level === "RED") return { outcome: "provider_unavailable", responsible: "atomicvid", provider: f.provider, reason: "provider capacity low or provider down" };
      if (row && row.level !== "UNKNOWN" && row.free !== null && row.units !== null && row.units > row.free)
        return { outcome: "provider_unavailable", responsible: "atomicvid", provider: f.provider, reason: "unreserved capacity below this production" };
      return { outcome: "unverifiable", responsible: "atomicvid", provider: f.provider, reason: row?.reason ?? "balance unverified or stale" };
    default:
      return { outcome: "unverifiable", responsible: "atomicvid", provider: f.provider, reason: f.reason };
  }
}

const RANK: Record<CheckOutcome, number> = { ready: 0, customer_limit: 1, needs_correction: 2, provider_unavailable: 3, unverifiable: 4 };

function render(issue: CheckIssue | undefined, estimate: ProductionEstimate | null, stage: ProductionEstimate["stage"]): Pick<ProductionCheck, "outcome" | "responsible" | "title" | "message" | "next"> {
  const nothing = stage === "before_script" ? "No se generó el guion ni se hizo ninguna llamada de pago." : "No se inició el render ni se hizo ninguna llamada de pago nueva; tu guion se conserva.";
  if (!issue) {
    const ceiling = estimate && estimate.ceilingUsd > 0 ? ` Techo estimado de proveedores: hasta USD ${estimate.ceilingUsd.toFixed(2)} (estimación conservadora, no es el precio exacto).` : "";
    return { outcome: "ready", responsible: "nadie", title: "Puedes continuar.", message: `Tu plan y la capacidad de los proveedores alcanzan para esta producción.${ceiling}`, next: stage === "before_script" ? "Genera el guion." : "Genera el video." };
  }
  switch (issue.outcome) {
    case "customer_limit":
      return { outcome: issue.outcome, responsible: "cliente", title: "Tu plan o tu saldo no alcanza para esta producción.", message: `${issue.reason} ${nothing}`, next: "Revisa tu plan o espera al próximo periodo; tu solicitud queda guardada." };
    case "provider_unavailable":
      return { outcome: issue.outcome, responsible: "atomicvid", title: `${label(issue.provider).replace(/^./, c => c.toUpperCase())} de Atomicvid no tiene ahora capacidad suficiente.`,
        message: `Es un límite o saldo de Atomicvid, no de tu cuenta: no tienes que recargar nada. ${nothing}`, next: "Atomicvid debe reponer esa capacidad. Vuelve a intentarlo más tarde; tu solicitud queda guardada." };
    case "unverifiable":
      return { outcome: issue.outcome, responsible: "atomicvid", title: `No podemos verificar ahora la disponibilidad de ${label(issue.provider)}.`,
        message: `Por seguridad no iniciamos ningún consumo sin esa confirmación; no es un problema de tu cuenta. ${nothing}`, next: "Vuelve a intentarlo en unos minutos. Si se repite, avisa a soporte." };
    case "needs_correction":
      return issue.responsible === "cliente"
        ? { outcome: issue.outcome, responsible: "cliente", title: "El contenido necesita una corrección antes de continuar.", message: `${issue.reason} ${nothing}`, next: "Corrige lo indicado y vuelve a intentarlo." }
        : { outcome: issue.outcome, responsible: "atomicvid", title: `La configuración de ${label(issue.provider)} en Atomicvid necesita una corrección.`,
          message: `No es un problema de tu cuenta. ${nothing}`, next: "Avisa a soporte; tu solicitud queda guardada." };
  }
}

export async function checkProduction(args: {
  service: SupabaseClient;
  user: { id: string; email?: string; email_confirmed_at?: string };
  ownerId: string;
  request: CheckRequest;
  stage: ProductionEstimate["stage"];
  voiceProvider: string;
  scriptProvider?: string;
  flags?: FeatureFlags;
  /** Test seams; production uses the real functions. */
  deps?: { assertCanGenerate?: typeof assertCanGenerate; ensureJobSupplyReady?: typeof ensureJobSupplyReady; guard?: boolean; now?: () => Date };
}): Promise<ProductionCheck> {
  const deps = args.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const issues: CheckIssue[] = [];
  const mode = args.request.mode ?? "visual";

  // 1. Customer rights. A database error is «unverifiable», never a refusal of the customer.
  try {
    const plan = await (deps.assertCanGenerate ?? assertCanGenerate)(args.service as never, args.ownerId, mode, args.user);
    if (!plan.allowed) issues.push({ outcome: "customer_limit", responsible: "cliente", reason: plan.reason });
  } catch {
    issues.push({ outcome: "unverifiable", responsible: "atomicvid", provider: "production", reason: "plan check unavailable" });
  }

  // 2. Prices: an operator value that is not a usable number is unknown, never the default.
  const priceIssues = scriptPricingIssues();
  if (priceIssues.length) issues.push({ outcome: "needs_correction", responsible: "atomicvid", provider: "anthropic", reason: `tarifa no verificable: ${priceIssues.join(", ")}` });

  // 3. Demands at this stage.
  let estimate: ProductionEstimate | null = null;
  let demands: JobSupplyDemand[] = [];
  try {
    const d = productionDemands(args.request, args.voiceProvider, args.stage, { flags: args.flags, scriptProvider: args.scriptProvider });
    demands = d.demands;
    estimate = { stage: args.stage, lines: d.lines, ceilingUsd: Math.round(d.lines.reduce((s, l) => s + l.usd, 0) * 100) / 100,
      note: args.stage === "before_script" ? "Techo conservador antes del guion; se recalcula con el guion real antes del video." : "Techo con el guion real; es el que se reserva al iniciar el video." };
  } catch (error) {
    const reason = error instanceof SupplyUnavailableError ? error.reason : "cost unverified";
    if (reason === "empty narration") issues.push({ outcome: "needs_correction", responsible: "cliente", reason: "El guion no tiene narración." });
    else issues.push({ outcome: "needs_correction", responsible: "atomicvid", provider: error instanceof SupplyUnavailableError ? error.provider : "production", reason });
  }

  // 4. Atomivid's provider capacity (mandatory in production).
  const guard = deps.guard ?? supplyGuardRequired();
  let providers: ProviderReadiness[] = [];
  if (guard && demands.length && !issues.some(i => i.outcome === "needs_correction" && i.responsible === "atomicvid")) {
    const readiness = await (deps.ensureJobSupplyReady ?? ensureJobSupplyReady)(args.service, demands).catch(() => ({ ready: false, providers: [], failure: { provider: "production", reason: "control unavailable" } }) as SupplyReadiness);
    providers = readiness.providers;
    const issue = classifyReadiness(readiness);
    if (issue) issues.push(issue);
  }

  issues.sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
  // The customer-facing primary answer: if the customer must act, say so first; Atomivid's problems are
  // still listed in `issues` (and never shown as the customer's fault).
  const primary = issues[0];
  return { ...render(primary, estimate, args.stage), estimate, issues, providers, supplyChecked: guard, checkedAt: now.toISOString(), voiceProvider: args.voiceProvider };
}

/** HTTP status for a refused check: 402 customer, 422 correction, 503 Atomivid capacity / unverifiable. */
export function checkHttpStatus(check: ProductionCheck): number {
  return check.outcome === "ready" ? 200 : check.outcome === "customer_limit" ? 402 : check.outcome === "needs_correction" ? 422 : 503;
}

/**
 * The check as the routes run it: provider names come from the same getters the pipeline uses. A missing
 * or invalid provider configuration (ProviderConfigurationError in production) is Atomivid's correction,
 * reported before anything is spent.
 */
export async function checkProductionForRequest(args: Omit<Parameters<typeof checkProduction>[0], "voiceProvider" | "scriptProvider">): Promise<ProductionCheck> {
  let voiceProvider: string, scriptProvider: string;
  try {
    const { getVoiceProvider } = await import("@/lib/providers/voice");
    const { getScriptProvider } = await import("@/lib/providers/script");
    voiceProvider = getVoiceProvider().name;
    scriptProvider = args.stage === "before_script" ? getScriptProvider().name : "anthropic";
  } catch {
    const issue: CheckIssue = { outcome: "needs_correction", responsible: "atomicvid", provider: "production", reason: "provider configuration unavailable" };
    return { ...render(issue, null, args.stage), estimate: null, issues: [issue], providers: [], supplyChecked: false, checkedAt: new Date().toISOString(), voiceProvider: null };
  }
  return checkProduction({ ...args, voiceProvider, scriptProvider });
}

/** JSON body for a refused start: what happened, who acts, next step, and the evidence behind it. */
export function checkResponseBody(check: ProductionCheck) {
  return {
    error: `${check.title} ${check.message} ${check.next}`.trim(),
    check: { outcome: check.outcome, responsible: check.responsible, title: check.title, message: check.message, next: check.next,
      estimate: check.estimate, issues: check.issues.map(i => ({ outcome: i.outcome, responsible: i.responsible, provider: i.provider ?? null, reason: i.reason })),
      supplyChecked: check.supplyChecked, checkedAt: check.checkedAt },
    // Retrying only helps when the cause can change on its own (capacity, verification); an Atomivid
    // configuration needs support. Nothing ran, so «none_proven» is proven here.
    outcome: { retry: check.outcome === "needs_correction" && check.responsible === "atomicvid" ? "support" as const : "available" as const, charge: "none_proven" as const },
    blocked: check.outcome !== "ready",
  };
}

/**
 * C. Recomprobación después del guion: the ceiling the customer saw BEFORE the script, without the script
 * calls (already done), against the ceiling with the real script. Recomputed from the request's current
 * duration, mode, recording and providers, so a change of any of them invalidates the old estimate by
 * construction (no stored quote can go stale). null = no increase (or nothing comparable).
 */
export function costIncrease(row: CheckRequest, check: ProductionCheck, flags?: FeatureFlags): { beforeUsd: number; afterUsd: number } | null {
  if (!check.estimate || check.estimate.stage !== "before_render" || !check.voiceProvider || (row.mode ?? "visual") === "long_form") return null;
  let before: number;
  try {
    before = productionDemands(row, check.voiceProvider, "before_script", { flags, scriptProvider: "none" }).lines.reduce((sum, l) => sum + l.usd, 0);
  } catch {
    return null;
  }
  const beforeUsd = Math.round(before * 100) / 100, afterUsd = check.estimate.ceilingUsd;
  return afterUsd > beforeUsd + 0.005 ? { beforeUsd, afterUsd } : null;
}
