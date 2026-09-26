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
import {
  computeProductionPlan,
  isProductionPlan,
  REAL_LONG_FORM_PROVIDER_NAMES,
  VISUAL_STRATEGIES,
  type ProductionPlan,
  type VisualStrategy,
} from "./production-plan";
import { getLongFormBudget } from "./cost";
import { validatePackagingInput } from "./packaging";

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
  input: { requestId: string; userId: string; strategy: unknown; packaging?: unknown; nowIso?: string },
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

  if (data.long_form_confirmed_at && isProductionPlan(data.long_form_production_plan)) {
    return { ok: true, plan: data.long_form_production_plan, confirmedAt: data.long_form_confirmed_at, alreadyConfirmed: true };
  }
  if (data.status !== "script_ready") {
    return { ok: false, status: 409, error: "Esta solicitud ya no está lista para confirmar producción." };
  }
  if (!isLongFormScriptJson(data.script_json)) {
    return { ok: false, status: 409, error: "El guion guardado no tiene la forma esperada para Long Form." };
  }

  const plan = computeProductionPlan({
    beats: data.script_json.beats.map((b) => ({
      id: b.id,
      type: b.type,
      narration: b.narration,
      visuals: (b as { visuals?: unknown }).visuals,
    })),
    topic: data.script_json.topic || data.topic || "",
    strategy,
    providers: REAL_LONG_FORM_PROVIDER_NAMES,
    requestedDurationSeconds: data.duration_seconds ?? undefined,
  });
  if (packagingCheck.packaging) plan.packaging = packagingCheck.packaging;
  const budget = getLongFormBudget();
  if (plan.estimatedProviderCostUsd > budget.maxTotalUsd) {
    return {
      ok: false,
      status: 409,
      error: `El costo estimado ($${plan.estimatedProviderCostUsd.toFixed(2)}) supera el tope de producción configurado ($${budget.maxTotalUsd.toFixed(2)}). Elige una estrategia más económica.`,
    };
  }

  const confirmedAt = input.nowIso ?? new Date().toISOString();
  const { data: updated, error: updateError } = await service
    .from("video_requests")
    .update({ long_form_production_plan: plan, long_form_confirmed_at: confirmedAt })
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
