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
import { ownScriptCallParamsFor, scriptCallParamsFor } from "@/lib/ai/script";
import { isOwnScriptDraft } from "@/lib/video/own-script";
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";
import { targetWordsFor } from "@/lib/video/script-pacing";
import { anthropicReservation, ceilLedgerUsd } from "./anthropic-cost";
import { jobSupplyDemands, type JobSupplyDemand, type SupplyJobInput } from "./job";
import { SupplyUnavailableError } from "./policy";
import { ensureJobSupplyReady, type ProviderReadiness, type SupplyReadiness } from "./readiness";
import { supplyGuardRequired } from "./server";
import type { ScriptLanguage } from "@/lib/providers/types";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { getRenderWorker } from "@/lib/worker";
import { scriptBlockState, type ScriptOpRow } from "./script-intent";
import type { DurationFit } from "@/lib/video/narration-fit";

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
  /** The same answer, item by item, in the order the owner listed them. Every item is a real server check. */
  checklist: ChecklistItem[];
};

export type ChecklistStatus = "ok" | "warning" | "blocked" | "unverified" | "not_applicable";
export type ChecklistItem = { id: ChecklistId; label: string; status: ChecklistStatus; detail: string; responsible: Responsible };
export type ChecklistId = "input" | "fit" | "plan" | "providers" | "processing" | "balances" | "budget" | "operations";

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
export function scriptGenerationCeilingUsd(input: { topic: string; style: string; durationSeconds: number; language?: ScriptLanguage | null; sourceText?: string }): number {
  return ceilingOf(scriptCallParamsFor({ topic: input.topic, style: input.style, durationSeconds: input.durationSeconds,
    language: input.language === "en" ? "en" : "es", sourceText: input.sourceText }));
}

/** «Usar mi propio guion»: ceiling of the scene-planning calls (visuals only; the narration is the customer's). */
export function ownScriptPlanCeilingUsd(input: { scenes: string[]; style: string; durationSeconds: number; language?: ScriptLanguage | null }): number {
  return ceilingOf(ownScriptCallParamsFor({ scenes: input.scenes, style: input.style, durationSeconds: input.durationSeconds, language: input.language === "en" ? "en" : "es" }));
}

function ceilingOf(calls: unknown[]): number {
  const pricing = getPricingConfig();
  const rates = { scriptInputUsdPer1MTokens: pricing.scriptInputUsdPer1MTokens, scriptOutputUsdPer1MTokens: pricing.scriptOutputUsdPer1MTokens };
  return calls.reduce<number>((sum, params) => sum + ceilLedgerUsd(anthropicReservation(params as Parameters<typeof anthropicReservation>[0], rates)), 0);
}

function basisFor(provider: string, stage: ProductionEstimate["stage"], unit: string, own: "own" | "adapt" | null): string {
  if (provider === "anthropic") return stage === "before_script"
    ? own === "own" ? "escenas visuales de tu guion (hasta 2 intentos; tu narración no se reescribe) y, si está activo, el director visual"
      : own === "adapt" ? "adaptación de tu texto a la duración (hasta 3 intentos) y, si está activo, el director visual"
      : "guion (hasta 3 intentos de longitud) y, si está activo, el director visual"
    : "director visual del guion real";
  if (unit === "character") return stage === "before_script" && own !== "own" ? "voz: palabras máximas aceptadas para la duración × 8 caracteres × 2 (una corrección de ritmo)" : "voz: caracteres reales del guion × corrección de ritmo";
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
  // An own script is sized with its REAL text (it will be narrated as is); an «adapt» or a generated script
  // has no final text yet and is sized with the duration ceiling.
  const draft = isOwnScriptDraft(row.script_json) ? row.script_json : null;
  const own = draft?.source ?? null;
  const scriptSource = stage === "before_script" && mode !== "long_form" && own !== "own"
    ? { segments: [{ text: "x".repeat(Math.max(1, narrationCharsCeiling(row.duration_seconds))) }] }
    : row.script_json;
  // jobSupplyDemands doubles Reel narration for the pacing correction; the synthetic text keeps that rule.
  const base = jobSupplyDemands({ mode, script_json: scriptSource, recorded_audio_path: row.recorded_audio_path,
    long_form_production_plan: row.long_form_production_plan ?? null }, voiceProvider, flags);
  const demands = new Map(base.map(d => [d.provider, { ...d }]));
  if (stage === "before_script" && mode !== "long_form" && !row.recorded_audio_path && (opts.scriptProvider ?? "anthropic") === "anthropic") {
    const usd = own === "own" && draft
      ? ownScriptPlanCeilingUsd({ scenes: draft.segments.map(s => s.text), style: row.style ?? "", durationSeconds: row.duration_seconds, language: row.language })
      : scriptGenerationCeilingUsd({ topic: row.topic ?? "", style: row.style ?? "", durationSeconds: row.duration_seconds, language: row.language, sourceText: draft?.ownText });
    if (!Number.isFinite(usd) || !(usd > 0)) throw new SupplyUnavailableError("anthropic", "job cost unverified");
    const prev = demands.get("anthropic");
    demands.set("anthropic", { provider: "anthropic", unit: "usd", units: usd + (prev?.units ?? 0), usd: usd + (prev?.usd ?? 0) });
  }
  const list = [...demands.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  return { demands: list, lines: list.map(d => ({ ...d, basis: basisFor(d.provider, stage, d.unit, own) })) };
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
      // This production's own script call: never repeated while running or uncertain (no double charge).
      if (issue.reason === "script call in flight")
        return { outcome: issue.outcome, responsible: "atomicvid", title: "Ya hay una generación en curso para esta producción.",
          message: "No iniciamos otra ni se cobra de nuevo; el resultado aparecerá al terminar.", next: "Espera unos minutos y actualiza la página." };
      if (issue.reason === "script call pending reconciliation")
        return { outcome: issue.outcome, responsible: "atomicvid", title: "Un intento anterior quedó pendiente de confirmar con el proveedor.",
          message: "No lo repetimos para no cobrar dos veces; no es un problema de tu cuenta.", next: "Soporte lo revisa; tu solicitud queda guardada." };
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
  /** Form/input validation already run by the caller (shared validators); a message blocks as the customer's correction. */
  inputError?: string | null;
  /** Own script compatibility with the duration (narration-fit.ts); null when Atomicvid writes the script. */
  fit?: DurationFit | null;
  /** Existing request: its script ledger rows are read so an uncertain or running call is reported (never repeated). */
  requestId?: string | null;
  /** Test seams; production uses the real functions. */
  deps?: { assertCanGenerate?: typeof assertCanGenerate; ensureJobSupplyReady?: typeof ensureJobSupplyReady; guard?: boolean; now?: () => Date;
    loadScriptRows?: (requestId: string) => Promise<ScriptOpRow[]>; processingConfigured?: () => boolean };
}): Promise<ProductionCheck> {
  const deps = args.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const issues: CheckIssue[] = [];
  const mode = args.request.mode ?? "visual";
  const item = new Map<ChecklistId, ChecklistItem>();
  const put = (id: ChecklistId, label: string, status: ChecklistStatus, detail: string, responsible: Responsible = "nadie") => item.set(id, { id, label, status, detail, responsible });

  // 0. The data itself: invalid input and a text that clearly does not fit are the customer's corrections.
  if (args.inputError) { issues.push({ outcome: "needs_correction", responsible: "cliente", reason: args.inputError }); put("input", "Datos y modalidad", "blocked", args.inputError, "cliente"); }
  else put("input", "Datos y modalidad", "ok", "Datos completos y modalidad disponible para tu cuenta.");
  if (!args.fit) put("fit", "Duración del texto", "not_applicable", args.request.recorded_audio_path ? "Se usa la duración real de tu grabación." : "Atomicvid escribe el guion para la duración elegida; se comprueba con el audio real.");
  else if (!args.fit.allowed) { issues.push({ outcome: "needs_correction", responsible: "cliente", reason: args.fit.message }); put("fit", "Duración del texto", "blocked", args.fit.message, "cliente"); }
  else put("fit", "Duración del texto", args.fit.verdict === "borderline" ? "warning" : "ok", args.fit.message, args.fit.verdict === "borderline" ? "cliente" : "nadie");

  // 1. Customer rights. A database error is «unverifiable», never a refusal of the customer.
  try {
    const plan = await (deps.assertCanGenerate ?? assertCanGenerate)(args.service as never, args.ownerId, mode, args.user);
    if (!plan.allowed) { issues.push({ outcome: "customer_limit", responsible: "cliente", reason: plan.reason }); put("plan", "Plan, permisos y créditos", "blocked", plan.reason, "cliente"); }
    else put("plan", "Plan, permisos y créditos", "ok", isInternalProductionOwner(args.user as never) ? "Producción interna del propietario: no consume créditos de un plan." : "Tu plan permite esta producción.");
  } catch {
    issues.push({ outcome: "unverifiable", responsible: "atomicvid", provider: "production", reason: "plan check unavailable" });
    put("plan", "Plan, permisos y créditos", "unverified", "No pudimos leer tu plan ahora; no iniciamos nada sin confirmarlo.", "atomicvid");
  }

  // 2. Prices: an operator value that is not a usable number is unknown, never the default.
  const priceIssues = scriptPricingIssues();
  if (priceIssues.length) issues.push({ outcome: "needs_correction", responsible: "atomicvid", provider: "anthropic", reason: `tarifa no verificable: ${priceIssues.join(", ")}` });
  // The processing worker must be configured BEFORE anything is paid (the render would refuse it later).
  const processingOk = (deps.processingConfigured ?? processingConfigured)();
  if (!processingOk) issues.push({ outcome: "needs_correction", responsible: "atomicvid", provider: "production", reason: "processing worker unconfigured" });
  put("processing", "Configuración del procesamiento", priceIssues.length || !processingOk ? "blocked" : "ok",
    priceIssues.length || !processingOk ? "Una tarifa o el servidor de procesamiento de Atomicvid no está configurado; no es un problema de tu cuenta." : "Tarifas y servidor de procesamiento configurados.",
    priceIssues.length || !processingOk ? "atomicvid" : "nadie");

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
  put("providers", "Proveedores necesarios", demands.length ? "ok" : "blocked",
    demands.length ? `Solo los que usa este recorrido: ${demands.map(d => label(d.provider).replace(/^el servicio de /, "")).join(", ")}.` : "No se pudo determinar el costo de algún proveedor; no se trata como cero.",
    demands.length ? "nadie" : "atomicvid");

  // 3b. This request's own paid operations: a running or uncertain script call is never repeated.
  if (args.requestId) {
    const rows = await (deps.loadScriptRows ?? defaultScriptRows)(args.requestId).catch(() => null);
    const block = rows ? scriptBlockState(rows, now.getTime()) : "requires_reconciliation";
    if (!rows) { issues.push({ outcome: "unverifiable", responsible: "atomicvid", provider: "anthropic", reason: "script ledger unreadable" }); put("operations", "Reservas y operaciones pendientes", "unverified", "No pudimos leer las operaciones de esta producción; no repetimos ninguna sin confirmarlo.", "atomicvid"); }
    else if (block) { issues.push({ outcome: "unverifiable", responsible: "atomicvid", provider: "anthropic", reason: block === "in_flight" ? "script call in flight" : "script call pending reconciliation" });
      put("operations", "Reservas y operaciones pendientes", "blocked", block === "in_flight" ? "Ya hay una generación en curso para esta producción; espera a que termine." : "Un intento anterior quedó pendiente de confirmar con el proveedor; no se repetirá para no cobrar dos veces. Soporte lo revisa.", "atomicvid"); }
    else put("operations", "Reservas y operaciones pendientes", "ok", "Ninguna operación en curso o incierta para esta producción.");
  } else put("operations", "Reservas y operaciones pendientes", "ok", "Producción nueva: no tiene reservas ni operaciones previas.");

  // 4. Atomivid's provider capacity (mandatory in production).
  const guard = deps.guard ?? supplyGuardRequired();
  let providers: ProviderReadiness[] = [];
  if (guard && demands.length && !issues.some(i => i.outcome === "needs_correction" && i.responsible === "atomicvid")) {
    const readiness = await (deps.ensureJobSupplyReady ?? ensureJobSupplyReady)(args.service, demands).catch(() => ({ ready: false, providers: [], failure: { provider: "production", reason: "control unavailable" } }) as SupplyReadiness);
    providers = readiness.providers;
    const issue = classifyReadiness(readiness);
    if (issue) issues.push(issue);
  }

  if (!guard) put("balances", "Saldos de proveedores de Atomicvid", "not_applicable", "Control de suministro desactivado en este entorno (solo desarrollo).");
  else if (!providers.length) put("balances", "Saldos de proveedores de Atomicvid", "unverified", "No se consultaron porque falta corregir un dato anterior.", "atomicvid");
  else {
    const bad = providers.find(p => !p.ok && p.failure !== "provider funded spend ceiling");
    const issue = issues.find(i => i.provider === bad?.provider);
    put("balances", "Saldos de proveedores de Atomicvid", bad ? (issue?.outcome === "unverifiable" ? "unverified" : "blocked") : "ok",
      bad ? `${label(bad.provider).replace(/^./, c => c.toUpperCase())}: ${issue?.outcome === "unverifiable" ? "saldo sin verificar o caducado" : "capacidad insuficiente"}. No es tu saldo: no tienes que recargar nada.`
        : "Saldos vigentes y suficientes, descontando lo ya reservado por otras producciones.", bad ? "atomicvid" : "nadie");
  }
  const ceilingHit = issues.find(i => i.reason === "provider funded spend ceiling" || i.reason === "global funded spend ceiling");
  put("budget", "Presupuesto estimado y límites", ceilingHit ? "blocked" : estimate ? "ok" : "unverified",
    ceilingHit ? "Se alcanzó un límite diario o mensual de gasto de Atomicvid; no es un límite de tu cuenta."
      : estimate ? `Techo conservador de proveedores: hasta USD ${estimate.ceilingUsd.toFixed(2)} (no es el precio exacto). ${estimate.note}` : "Sin estimación verificable; no iniciamos nada.",
    ceilingHit || !estimate ? "atomicvid" : "nadie");

  issues.sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
  // The customer-facing primary answer: if the customer must act, say so first; Atomivid's problems are
  // still listed in `issues` (and never shown as the customer's fault).
  const primary = issues[0];
  const order: ChecklistId[] = ["input", "fit", "plan", "providers", "processing", "balances", "budget", "operations"];
  return { ...render(primary, estimate, args.stage), estimate, issues, providers, supplyChecked: guard, checkedAt: now.toISOString(), voiceProvider: args.voiceProvider,
    checklist: order.map(id => item.get(id)).filter((x): x is ChecklistItem => Boolean(x)) };
}

async function defaultScriptRows(requestId: string): Promise<ScriptOpRow[]> {
  const { loadScriptOperations } = await import("./anthropic");
  return loadScriptOperations(requestId);
}

/** Same rule the render route applies (getRenderWorker), evaluated without dispatching anything. */
function processingConfigured(): boolean {
  try {
    getRenderWorker();
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP status for a refused check: 402 customer, 422 correction, 409 this production's own call running or
 * uncertain (the status POST /script always answered for it), 503 Atomivid capacity / unverifiable.
 */
export function checkHttpStatus(check: ProductionCheck): number {
  if (check.outcome === "ready") return 200;
  if (check.issues[0]?.reason === "script call in flight" || check.issues[0]?.reason === "script call pending reconciliation") return 409;
  return check.outcome === "customer_limit" ? 402 : check.outcome === "needs_correction" ? 422 : 503;
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
    return { ...render(issue, null, args.stage), estimate: null, issues: [issue], providers: [], supplyChecked: false, checkedAt: new Date().toISOString(), voiceProvider: null,
      checklist: [{ id: "processing", label: "Configuración del procesamiento", status: "blocked", detail: "La configuración de proveedores de Atomicvid no está disponible; no es un problema de tu cuenta.", responsible: "atomicvid" }] };
  }
  return checkProduction({ ...args, voiceProvider, scriptProvider });
}

/** JSON body for a refused start: what happened, who acts, next step, and the evidence behind it. */
export function checkResponseBody(check: ProductionCheck) {
  return {
    error: `${check.title} ${check.message} ${check.next}`.trim(),
    check: { outcome: check.outcome, responsible: check.responsible, title: check.title, message: check.message, next: check.next, checklist: check.checklist,
      estimate: check.estimate, issues: check.issues.map(i => ({ outcome: i.outcome, responsible: i.responsible, provider: i.provider ?? null, reason: i.reason })),
      supplyChecked: check.supplyChecked, checkedAt: check.checkedAt },
    // Retrying only helps when the cause can change on its own (capacity, verification); an Atomivid
    // configuration needs support. Nothing ran, so «none_proven» is proven here.
    outcome: { retry: (check.outcome === "needs_correction" && check.responsible === "atomicvid") || check.issues[0]?.reason === "script call pending reconciliation" ? "support" as const : "available" as const, charge: "none_proven" as const },
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
