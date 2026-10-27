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
  },
): Promise<ConfirmProductionResult> {
  if (!isVisualStrategyValue(input.strategy)) return { ok: false, status: 400, error: "Estrategia visual inválida" };
  const strategy = input.strategy;
  // Presentación (portada/miniatura): revalidada aquí; el navegador nunca decide si es legible.
  const packagingCheck = validatePackagingInput(input.packaging);
  if (!packagingCheck.ok) return { ok: false, status: 400, error: packagingCheck.error };

  const { data, error: fetchError } = await service
    .from("video_requests")
    .select("id, mode, user_id, status, topic, duration_seconds, script_json, long_form_production_plan, long_form_confirmed_at")
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

  const { plan } = productPlan({
    beats: data.script_json.beats.map((b) => ({
      id: b.id,
      type: b.type,
      purpose: b.purpose,
      narration: b.narration,
      visuals: (b as { visuals?: unknown }).visuals,
    })),
    topic: data.script_json.topic || data.topic || "",
    strategy,
    providers: { ...getRealLongFormProviderNames(), ...(input.recraft ? { image: "recraft" } : {}) },
    requestedDurationSeconds: data.duration_seconds ?? undefined,
    cinematicV6: input.cinematicV6 === true,
  });
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
