/**
 * Confirmación humana de una producción de Long Form (paso 9/10 del
 * contrato). Única forma de fijar long_form_confirmed_at, que render/route.ts
 * y run-job.ts exigen antes de cualquier gasto audiovisual.
 *
 * - El plan SIEMPRE se recalcula aquí, a partir del guion guardado — el
 *   navegador solo elige la estrategia, nunca envía un plan ni un costo.
 * - UPDATE condicional (`long_form_confirmed_at IS NULL` + status
 *   script_ready): dos confirmaciones simultáneas producen una sola.
 * - Idempotente: una confirmación repetida (doble clic, pestaña vieja con
 *   otra estrategia) devuelve la YA confirmada, nunca la sobrescribe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLongFormScriptJson } from "./script-json";
import { editorialApprovalError } from "./editorial";
import {
  isProductionPlan,
  getRealLongFormProviderNames,
  VISUAL_STRATEGIES,
  type ProductionPlan,
  type VisualStrategy,
} from "./production-plan";
import { getLongFormBudget } from "./cost";
import { loadScriptSpentUsd, workerBudgetForPlan, previewWorkerAuthorization, type WorkerAuthorization } from "./worker-budget-preview";
import type { ObservedMax } from "./spend-cap";
import { validatePackagingInput } from "./packaging";
import { productPlan } from "./product-plan";
import { usesAnchoredVisuals, usesVisualIdentity } from "./production-plan-types";
import { datedEventBlockMessage, datedEventEvidenceBlockers } from "./dated-event-preflight";
import type { ProductionPlanBeatInput } from "./production-plan";
import { visualBlockMessage, visualCheck, type VisualCheck } from "./production-preflight";
import type { ReelRecraftStyle } from "@/lib/video/recraft-reel";
import type { FootageProvider } from "@/lib/providers/types";
import { materialAwarePlan, materialCheckFootageProvider, MATERIAL_CHECK_DEADLINE_MS, withSearchDeadline } from "./material-plan";
import { materialBlockText } from "./material-gap-message";
import { budgetUsed, productionBudgetPath, type ProductionBudgetState } from "./production-budget";

function defaultStaleBudget(service: SupabaseClient, requestId: string) {
  const path = productionBudgetPath(requestId);
  return {
    async load(): Promise<ProductionBudgetState | null> {
      // Existence first (the usual first confirmation has no file); a listed file that cannot be read fails closed.
      const { data: listed, error: listError } = await service.storage.from("videos").list(`${requestId}/state`, { search: "production-budget.json" });
      if (listError) throw new Error(listError.message);
      if (!listed?.some((f) => f.name === "production-budget.json")) return null;
      const { data, error } = await service.storage.from("videos").download(path);
      if (error || !data) throw new Error(error?.message ?? "presupuesto no legible");
      const text = await data.text();
      return text ? (JSON.parse(text) as ProductionBudgetState) : null;
    },
    async remove() {
      const { error } = await service.storage.from("videos").remove([path]);
      if (error) throw new Error(error.message);
    },
  };
}

export function isVisualStrategyValue(value: unknown): value is VisualStrategy {
  return typeof value === "string" && (VISUAL_STRATEGIES as readonly string[]).includes(value);
}

type Row = {
  id: string;
  mode: string;
  user_id: string;
  status: string;
  topic: string | null;
  duration_seconds?: number | null;
  script_json: unknown;
  long_form_production_plan: unknown;
  long_form_confirmed_at: string | null;
  reel_voice_id?: string | null;
};

export type ConfirmProductionResult =
  | { ok: true; plan: ProductionPlan; confirmedAt: string; alreadyConfirmed: boolean }
  | { ok: false; status: number; error: string };

export async function confirmLongFormProduction(
  service: SupabaseClient,
  input: {
    requestId: string;
    userId: string;
    strategy: unknown;
    packaging?: unknown;
    nowIso?: string;
    /** Cuenta con Cinematic V6 (cinematic-v6-access.ts, decidido server-side). Sin él, el plan es v3. */
    cinematicV6?: boolean;
    /** Tests only: replaces the visual release check (production always uses visualCheck). */
    visualGate?: (plan: ProductionPlan) => Promise<VisualCheck>;
    /**
     * «Imágenes IA con Recraft», already validated and permitted by the route (recraftAllowedFor + parseRecraftSelection,
     * references stored in our bucket). The plan pins image provider "recraft" and the choice is written in the SAME
     * conditional update as the confirmation (DB trigger: immutable afterwards). Absent = default (OpenAI) images.
     */
    recraft?: ReelRecraftStyle;
    /**
     * Voz de narración elegida para ESTE documental, ya validada por la ruta contra el catálogo del usuario
     * (resolveReelVoiceSelection: voces privadas solo con su concesión). Se escribe en el MISMO UPDATE condicional que
     * confirma (trigger: inmutable después). Ausente = voz predeterminada del producto, como siempre.
     */
    voiceId?: string;
    /**
     * Tests only. Production loads script spend and the ledger's observed unit prices — the same
     * inputs produce.ts feeds to authorizeRequestBudget — and refuses when those stages do not fit.
     */
    budgetFacts?: { scriptSpentUsd: number; observed?: ObservedMax };
    /**
     * Proveedor de archivo para la comprobación de material (material-plan.ts). Ausente = el del entorno
     * (null si es fixture / sin clave: la comprobación queda para el inicio). null = no comprobar (pruebas).
     */
    materialFootage?: FootageProvider | null;
    /**
     * Tests only: the stored production budget of an earlier confirmation (a request reopened after a $0 material
     * stop). Production reads and removes `<id>/state/production-budget.json` in the videos bucket.
     */
    staleBudget?: { load(): Promise<ProductionBudgetState | null>; remove(): Promise<void> };
  },
): Promise<ConfirmProductionResult> {
  if (!isVisualStrategyValue(input.strategy)) return { ok: false, status: 400, error: "Estrategia visual inválida" };
  const strategy = input.strategy;
  // Presentación (portada/miniatura): revalidada aquí; el navegador nunca decide si es legible.
  const packagingCheck = validatePackagingInput(input.packaging);
  if (!packagingCheck.ok) return { ok: false, status: 400, error: packagingCheck.error };

  const { data, error: fetchError } = await service
    .from("video_requests")
    .select("id, mode, user_id, status, topic, duration_seconds, script_json, long_form_production_plan, long_form_confirmed_at, reel_voice_id")
    .eq("id", input.requestId)
    .maybeSingle<Row>();
  if (fetchError || !data) return { ok: false, status: 404, error: "Solicitud no encontrada" };
  if (data.user_id !== input.userId) return { ok: false, status: 403, error: "No autorizado" };
  if (data.mode !== "long_form") return { ok: false, status: 409, error: "Esta solicitud no es de Long Form" };
  if (isLongFormScriptJson(data.script_json)) {
    const editorialError = editorialApprovalError(data.script_json);
    if (editorialError) return { ok: false, status: 409, error: editorialError };
  }

  if (data.long_form_confirmed_at && isProductionPlan(data.long_form_production_plan)) {
    return { ok: true, plan: data.long_form_production_plan, confirmedAt: data.long_form_confirmed_at, alreadyConfirmed: true };
  }
  if (data.status !== "script_ready") {
    return { ok: false, status: 409, error: "Esta solicitud ya no está lista para confirmar producción." };
  }
  if (!isLongFormScriptJson(data.script_json)) {
    return { ok: false, status: 409, error: "El guion guardado no tiene la forma esperada para Long Form." };
  }
  // A request reopened after a $0 material failure (reconfigure-production.ts) keeps the voice of its first
  // confirmation: the column is immutable (DB trigger), so a different voice is refused here, never at the UPDATE.
  if (data.reel_voice_id && input.voiceId && input.voiceId !== data.reel_voice_id) {
    return { ok: false, status: 409, error: "Este documental ya tiene fijada la voz de su primera confirmación; elige esa misma voz o deja la predeterminada (se usará la ya fijada). No se confirmó ni se cobró nada." };
  }

  const beats = data.script_json.beats.map((b) => ({
    id: b.id,
    type: b.type,
    purpose: b.purpose,
    narration: b.narration,
    visuals: (b as { visuals?: unknown }).visuals,
  }));
  const topic = data.script_json.topic || data.topic || "";
  // Same material check as the Configure page (and as produce() before spending): scenes without relevant, unique
  // stock become AI images priced in THIS plan, or the plan is refused before it is locked.
  const footage = input.materialFootage !== undefined ? input.materialFootage : materialCheckFootageProvider();
  const { result: { plan }, material } = await materialAwarePlan({
    beats: beats as ProductionPlanBeatInput[],
    topic,
    footageProvider: footage ? withSearchDeadline(footage, Date.now() + MATERIAL_CHECK_DEADLINE_MS) : null,
    build: (materialGapImages) => productPlan({
      beats,
      topic,
      strategy,
      providers: { ...getRealLongFormProviderNames(), ...(input.recraft ? { image: "recraft" } : {}) },
      requestedDurationSeconds: data.duration_seconds ?? undefined,
      cinematicV6: input.cinematicV6 === true,
      materialGapImages,
    }),
  });
  if (material.status === "unavoidable_gap") {
    return { ok: false, status: 409, error: `No se puede confirmar: ${materialBlockText(material, strategy)} No se confirmó ni se cobró nada.` };
  }
  if (material.status === "temporary_error") {
    return { ok: false, status: 503, error: `No se pudo comprobar el material de archivo ahora (${material.reason}). No se confirmó ni se cobró nada; vuelve a intentarlo en unos minutos.` };
  }
  if (packagingCheck.packaging) plan.packaging = packagingCheck.packaging;
  const budget = getLongFormBudget();
  // Same formula as the worker (script already spent + conservative units + music + render worst case).
  // Provider-only `estimatedProviderCostUsd` can sit under the ceiling while that total does not.
  let authorization: WorkerAuthorization;
  try {
    authorization = input.budgetFacts
      ? previewWorkerAuthorization({ plan, scriptSpentUsd: input.budgetFacts.scriptSpentUsd, observed: input.budgetFacts.observed ?? {}, hardMaxUsd: budget.maxTotalUsd })
      : await workerBudgetForPlan(service, plan, { scriptSpentUsd: await loadScriptSpentUsd(service, input.requestId), hardMaxUsd: budget.maxTotalUsd });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "error de lectura";
    return { ok: false, status: 409, error: `No se pudo comprobar el presupuesto total antes de confirmar (${detail}). No se confirmó ni se cobró nada.` };
  }
  if (!authorization.admits) return { ok: false, status: 409, error: authorization.userMessage };

  // Visual release gate (v4+): the plan is never locked while the worker would refuse it before spending.
  if (usesVisualIdentity(plan)) {
    const script = data.script_json as unknown as { topic: string; beats: ProductionPlanBeatInput[] };
    const visual = await (input.visualGate ?? ((p: ProductionPlan) => visualCheck(service, { requestId: input.requestId, plan: p, beats: script.beats, topic: script.topic || data.topic || "" })))(plan);
    if (!visual.ready) return { ok: false, status: 409, error: visualBlockMessage(visual) };
  } else if (usesAnchoredVisuals(plan)) {
    // v3: el worker rechazaría antes de gastar un acontecimiento fechado ilustrado con material genérico
    // (dated-event-preflight.ts); el plan no se bloquea como confirmado para luego fallar.
    const script = data.script_json as unknown as { beats: ProductionPlanBeatInput[] };
    const dated = datedEventEvidenceBlockers(script.beats ?? []);
    if (dated.length > 0) return { ok: false, status: 409, error: datedEventBlockMessage(dated.length) };
  }

  // A request reopened after a $0 material stop may still hold the earlier confirmation's production budget (its
  // removal after the reopen is best effort). ProductionBudget.open never widens it, so the new plan would be clamped
  // to the old allocation: remove it while it is unused; with any recorded use, never confirm over it.
  const stale = input.staleBudget ?? defaultStaleBudget(service, input.requestId);
  try {
    const previous = await stale.load();
    if (previous && budgetUsed(previous)) {
      return { ok: false, status: 409, error: "Este documental conserva un presupuesto de producción con uso registrado; no se puede confirmar un plan nuevo. Contacta al soporte. No se confirmó ni se cobró nada." };
    }
    if (previous) await stale.remove();
  } catch {
    return { ok: false, status: 503, error: "No se pudo comprobar el presupuesto de producción anterior. No se confirmó ni se cobró nada; inténtalo de nuevo." };
  }

  const confirmedAt = input.nowIso ?? new Date().toISOString();
  const { data: updated, error: updateError } = await service
    .from("video_requests")
    .update({ long_form_production_plan: plan, long_form_confirmed_at: confirmedAt,
      ...(input.recraft ? { reel_image_source: "recraft", reel_recraft_style: input.recraft } : {}),
      ...(input.voiceId ? { reel_voice_id: input.voiceId } : {}) })
    .eq("id", input.requestId)
    .eq("user_id", input.userId)
    .eq("status", "script_ready")
    .is("long_form_confirmed_at", null)
    .select("long_form_production_plan, long_form_confirmed_at")
    .maybeSingle<{ long_form_production_plan: unknown; long_form_confirmed_at: string | null }>();

  if (updateError) throw updateError;
  if (updated && isProductionPlan(updated.long_form_production_plan) && updated.long_form_confirmed_at) {
    return { ok: true, plan: updated.long_form_production_plan, confirmedAt: updated.long_form_confirmed_at, alreadyConfirmed: false };
  }

  // Otra confirmación ganó la carrera entre la lectura y el UPDATE: se
  // devuelve la suya (idempotente), nunca una segunda.
  const { data: winner } = await service
    .from("video_requests")
    .select("long_form_production_plan, long_form_confirmed_at")
    .eq("id", input.requestId)
    .maybeSingle<{ long_form_production_plan: unknown; long_form_confirmed_at: string | null }>();
  if (winner?.long_form_confirmed_at && isProductionPlan(winner.long_form_production_plan)) {
    return { ok: true, plan: winner.long_form_production_plan, confirmedAt: winner.long_form_confirmed_at, alreadyConfirmed: true };
  }
  return { ok: false, status: 409, error: "El estado cambió justo antes de confirmar. Intenta de nuevo." };
}
