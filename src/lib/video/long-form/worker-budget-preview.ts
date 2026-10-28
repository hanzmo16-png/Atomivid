/**
 * Same stage total the worker authorizes in produce.ts (script already spent + conservative
 * voice/images/video + music + render worst case) before LONG_FORM_MAX_TOTAL_USD.
 *
 * Contingency may be clipped down to the product ceiling. The stages themselves may not:
 * clipping them is what lets a plan confirm and then stop after paying for voice and images.
 * The worker on production (762714e) still clips; PR #223 refuses that case inside
 * authorizeRequestBudget. This preview is the confirm/configure gate so the two formulas match.
 * It does not raise the ceiling and does not authorize spend.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPricingConfig } from "@/lib/billing/pricing";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { getLongFormBudget, LONG_FORM_RENDER_JOB_TIMEOUT_MIN, longFormRenderCeilingUsd } from "./cost";
import { pilotBudgetEnvelope, type PilotStageEstimate } from "./pilot-budget-envelope";
import { getGenerativeUnitCosts, type ProductionPlan } from "./production-plan";
import { executionAllocation } from "./production-plan-types";
import { requestSpend } from "./request-budget";
import { documentaryLedgerScopeFor } from "./script-jobs";
import { conservativeUnits, loadObservedMax, type ObservedMax } from "./spend-cap";

// One source for the render worst case: the worker (produce.ts) and this preview read the same function.
export { LONG_FORM_RENDER_JOB_TIMEOUT_MIN, longFormRenderCeilingUsd };

/** Music stage the worker sends to pilotBudgetEnvelope. Unknown Beatoven price blocks; anything else is USD 0. */
export function musicCeilingUsd(musicProvider: string | undefined, env: Record<string, string | undefined> = process.env): number | null {
  if (musicProvider !== "beatoven") return 0;
  const raw = env.BEATOVEN_ESTIMATED_COST_USD;
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function contingencyPctFromEnv(env: Record<string, string | undefined> = process.env): number {
  return Number(env.LONG_FORM_BUDGET_CONTINGENCY_PCT || "20");
}

export type WorkerAuthorization = {
  admits: boolean;
  blockers: string[];
  scriptSpentUsd: number;
  voiceUsd: number | null;
  imageUsd: number | null;
  videoUsd: number | null;
  musicUsd: number | null;
  renderUsd: number;
  subtotalUsd: number | null;
  contingencyPct: number;
  proposedCeilingUsd: number | null;
  /** min(proposed, product ceiling) when the stages fit; null when they do not. */
  authorizedCeilingUsd: number | null;
  contingencyClipped: boolean;
  userMessage: string;
};

function money(n: number): string {
  return n.toFixed(2);
}

export function previewWorkerAuthorization(input: {
  plan: ProductionPlan;
  scriptSpentUsd: number;
  observed?: ObservedMax;
  hardMaxUsd: number;
  contingencyPct?: number;
  musicCeilingUsd?: number | null;
  renderUsd?: number;
}): WorkerAuthorization {
  const plan = input.plan;
  const allocation = executionAllocation(plan);
  const units = getGenerativeUnitCosts(plan.providers?.aiVideo, plan.providers?.image);
  const conservative = conservativeUnits(
    { imageUsd: units.imageUsd, clipUsd: units.veoClipUsd, voiceUsdPer1kChars: getPricingConfig().elevenLabsUsdPer1kChars },
    input.observed ?? {},
  );
  const voiceUsd: number | null = Number.isFinite(plan.voiceCharacters)
    ? (plan.voiceCharacters / 1000) * conservative.voiceUsdPer1kChars
    : typeof plan.estimatedVoiceCostUsd === "number" && Number.isFinite(plan.estimatedVoiceCostUsd) ? plan.estimatedVoiceCostUsd : null;
  const imageUsd = Number.isFinite(allocation.maxAiImageGenerations) ? conservative.imageUsd * allocation.maxAiImageGenerations : null;
  const videoUsd = Number.isFinite(allocation.maxAiVideoClips) ? conservative.clipUsd * allocation.maxAiVideoClips : null;
  const musicUsd = input.musicCeilingUsd !== undefined ? input.musicCeilingUsd : musicCeilingUsd(plan.providers?.music);
  const renderUsd = input.renderUsd ?? longFormRenderCeilingUsd();
  const scriptSpentUsd = Number.isFinite(input.scriptSpentUsd) && input.scriptSpentUsd >= 0 ? input.scriptSpentUsd : Number.NaN;
  const contingencyPct = input.contingencyPct ?? contingencyPctFromEnv();
  const hardMaxUsd = Number.isFinite(input.hardMaxUsd) ? Math.max(0, input.hardMaxUsd) : 0;
  const stages: PilotStageEstimate[] = [
    { stage: "research", ceilingUsd: 0, retryPolicy: "reuse_paid_results", note: "incluida en «script»: mismo proyecto del ledger del guion" },
    { stage: "script", ceilingUsd: Number.isFinite(scriptSpentUsd) ? scriptSpentUsd : null, retryPolicy: "reuse_paid_results", note: "gasto ya registrado del guion e investigación" },
    { stage: "style", ceilingUsd: 0, retryPolicy: "reuse_paid_results", note: "creación de estilo incluida en «images» cuando el plan es Recraft" },
    { stage: "voice", ceilingUsd: voiceUsd, retryPolicy: "reuse_paid_results" },
    { stage: "images", ceilingUsd: imageUsd, retryPolicy: "reuse_paid_results" },
    { stage: "video", ceilingUsd: videoUsd, retryPolicy: "reuse_paid_results" },
    { stage: "music", ceilingUsd: musicUsd, retryPolicy: "reuse_paid_results" },
    { stage: "render", ceilingUsd: Number.isFinite(renderUsd) && renderUsd >= 0 ? renderUsd : null, retryPolicy: "reuse_paid_results", note: `cubre ${MAX_RENDER_ATTEMPTS} intentos × ${LONG_FORM_RENDER_JOB_TIMEOUT_MIN} min` },
  ];
  const envelope = pilotBudgetEnvelope(stages, contingencyPct);
  const subtotal = envelope.subtotalUsd;
  const stagesFit = envelope.ready && subtotal !== null && subtotal <= hardMaxUsd + 1e-9;
  const blockers = stagesFit ? [] : [
    ...envelope.blockers,
    ...(envelope.ready && subtotal !== null && subtotal > hardMaxUsd + 1e-9 ? [`subtotal_exceeds_ceiling:${subtotal.toFixed(2)}>${hardMaxUsd.toFixed(2)}`] : []),
  ];
  const proposed = envelope.proposedAuthorizationCeilingUsd;
  const admits = stagesFit && proposed !== null;
  const authorizedCeilingUsd = admits && proposed !== null ? Math.min(proposed, hardMaxUsd) : null;
  const contingencyClipped = admits && proposed !== null && proposed > hardMaxUsd + 1e-9;
  const parts = [
    `guion ya gastado $${money(Number.isFinite(scriptSpentUsd) ? scriptSpentUsd : 0)}`,
    voiceUsd !== null ? `voz $${money(voiceUsd)}` : "voz sin precio",
    imageUsd !== null ? `imágenes $${money(imageUsd)}` : "imágenes sin precio",
    videoUsd !== null ? `video $${money(videoUsd)}` : "video sin precio",
    musicUsd !== null ? `música $${money(musicUsd)}` : "música sin precio verificado",
    `render en el peor caso $${money(Number.isFinite(renderUsd) ? renderUsd : 0)}`,
  ];
  const userMessage = admits
    ? contingencyClipped
      ? `Cabe el subtotal de $${money(subtotal!)} dentro del tope de $${money(hardMaxUsd)}. La contingencia del ${contingencyPct}% ($${money(proposed!)}) se recorta: se autorizarían $${money(authorizedCeilingUsd!)}. Aún no se cobra nada.`
      : `El worker autorizaría $${money(authorizedCeilingUsd!)} (subtotal $${money(subtotal!)} + contingencia ${contingencyPct}%). Aún no se cobra nada.`
    : blockers.some((b) => b.startsWith("unverified_cost:music") || b.startsWith("missing_stage:music"))
      ? "La música de Beatoven no tiene un precio verificado (BEATOVEN_ESTIMATED_COST_USD). No se confirma ni se cobra nada."
      : subtotal !== null && subtotal > hardMaxUsd + 1e-9
        ? `El presupuesto que el worker exige antes de gastar (${parts.join(" + ")} = $${money(subtotal)}) supera el tope de $${money(hardMaxUsd)}. La contingencia no se recorta para hacer caber etapas que no caben. Elige una estrategia más económica. No se confirmó ni se cobró nada.`
        : `No se puede autorizar el presupuesto total (${blockers.join(", ") || "precio sin verificar"}). No se confirmó ni se cobró nada.`;
  return {
    admits, blockers, scriptSpentUsd: Number.isFinite(scriptSpentUsd) ? scriptSpentUsd : 0,
    voiceUsd, imageUsd, videoUsd, musicUsd, renderUsd: Number.isFinite(renderUsd) ? renderUsd : 0,
    subtotalUsd: subtotal, contingencyPct, proposedCeilingUsd: proposed, authorizedCeilingUsd, contingencyClipped, userMessage,
  };
}

export function refusedAuthorization(reason: string): WorkerAuthorization {
  return {
    admits: false,
    blockers: [`unreadable:${reason}`],
    scriptSpentUsd: 0,
    voiceUsd: null,
    imageUsd: null,
    videoUsd: null,
    musicUsd: null,
    renderUsd: longFormRenderCeilingUsd(),
    subtotalUsd: null,
    contingencyPct: contingencyPctFromEnv(),
    proposedCeilingUsd: null,
    authorizedCeilingUsd: null,
    contingencyClipped: false,
    userMessage: `No se pudo comprobar el presupuesto total (${reason}). No se confirma ni se cobra nada.`,
  };
}

/** Script/research already on the ledger for this request. No row means USD 0, same as the worker. */
export async function loadScriptSpentUsd(service: SupabaseClient, requestId: string): Promise<number> {
  const { data, error } = await service.from("documentary_script_jobs").select("user_id,input").eq("request_id", requestId).maybeSingle();
  if (error) throw new Error(`No se pudo leer el gasto del guion (${error.message})`);
  if (!data) return 0;
  const scope = documentaryLedgerScopeFor(data);
  if (!scope) throw new Error("El guion de este pedido no permite localizar su gasto en el ledger");
  const ledger = supabaseLedgerStore(service);
  if (!ledger.listByProjects) throw new Error("El ledger no permite sumar el gasto del guion");
  const ops = await ledger.listByProjects([scope]);
  return requestSpend(ops).totalUsd;
}

/** One authorization per plan, sharing one script-spend figure. A failed price read refuses that plan only. */
export async function budgetsForPlans(
  service: SupabaseClient,
  plans: Record<string, ProductionPlan>,
  scriptSpent: number | { error: string },
): Promise<Record<string, WorkerAuthorization>> {
  if (typeof scriptSpent !== "number") {
    return Object.fromEntries(Object.keys(plans).map((key) => [key, refusedAuthorization(scriptSpent.error)]));
  }
  const hardMaxUsd = getLongFormBudget().maxTotalUsd;
  const observedCache = new Map<string, ObservedMax | Error>();
  const out: Record<string, WorkerAuthorization> = {};
  for (const [key, plan] of Object.entries(plans)) {
    const cacheKey = `${plan.providers?.image ?? ""}|${plan.providers?.aiVideo ?? ""}`;
    let observed = observedCache.get(cacheKey);
    if (observed === undefined) {
      try {
        observed = await loadObservedMax(service, { image: plan.providers.image, aiVideo: plan.providers.aiVideo });
      } catch (error) {
        observed = error instanceof Error ? error : new Error("costo observado");
      }
      observedCache.set(cacheKey, observed);
    }
    out[key] = observed instanceof Error
      ? refusedAuthorization(observed.message)
      : previewWorkerAuthorization({ plan, scriptSpentUsd: scriptSpent, observed, hardMaxUsd });
  }
  return out;
}

/** Observed image/clip maxima are part of the worker's conservative price. Pass `observed` to skip the read (tests). */
export async function workerBudgetForPlan(
  service: SupabaseClient,
  plan: ProductionPlan,
  facts: { scriptSpentUsd: number; hardMaxUsd: number; contingencyPct?: number; observed?: ObservedMax },
): Promise<WorkerAuthorization> {
  const observed = facts.observed ?? await loadObservedMax(service, { image: plan.providers.image, aiVideo: plan.providers.aiVideo });
  return previewWorkerAuthorization({ plan, scriptSpentUsd: facts.scriptSpentUsd, observed, hardMaxUsd: facts.hardMaxUsd, contingencyPct: facts.contingencyPct });
}
