/**
 * Reconfigurar un Long Form después de un impedimento de material SIN gasto (incidente 2026-10-28: 34 escenas sin
 * material, USD 0). Antes, el plan confirmado quedaba fijo: «Reintentar» repetía el mismo fallo y Configurar
 * redirigía al resultado. Esta transición explícita, solo del dueño, devuelve el pedido a «script_ready» para elegir
 * otra estrategia; el guion (ya pagado) se conserva y no se cobra nada.
 *
 * Solo procede cuando TODO esto se cumple (si no, se rechaza sin tocar nada):
 *  - el pedido es del usuario, es Long Form, está «failed» con el error de material no disponible y tiene plan confirmado;
 *  - no hay ninguna operación de producción (pi_paid_operations del pedido) comprometida, abierta o con importe;
 *  - el presupuesto de producción guardado no registra uso y no existe autorización de presupuesto total del pedido
 *    (ambas solo nacen al pasar la comprobación de material; con ellas se deriva a soporte);
 *  - la imagen del documental no está fijada en Recraft (elección inmutable: una nueva confirmación no podría escribirla).
 * El UPDATE es condicional (compare-and-swap sobre estado, confirmación y mensaje leídos): dos clics, una sola
 * transición; repetirla después devuelve «ya reabierto».
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeStoredFailure } from "@/lib/video/failure-action";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import type { PaidOperation } from "@/lib/production-intelligence/ledger";
import { MATERIAL_UNAVAILABLE_PREFIX } from "./material-preflight";
import { productionBudgetPath, type ProductionBudgetState } from "./production-budget";
import { requestSpend } from "./request-budget";

const BUCKET = "videos";

/** True when the stored failure is the material-unavailable stop (never a support-tagged failure). */
export function isMaterialUnavailableFailure(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  const decoded = decodeStoredFailure(errorMessage);
  return decoded.action !== "support" && decoded.message.startsWith(MATERIAL_UNAVAILABLE_PREFIX);
}

/** Paid operations that are production spend (the documentary script is billed in its own ledger scope). */
function productionOps(ops: PaidOperation[]): PaidOperation[] {
  return ops.filter((op) => !(op.provider === "anthropic" && op.method === "generate_script"));
}

export type ReconfigureDeps = {
  listOperations?: (requestId: string) => Promise<PaidOperation[]>;
  loadBudget?: (requestId: string) => Promise<ProductionBudgetState | null>;
  removeBudget?: (requestId: string) => Promise<void>;
  authorizationExists?: (requestId: string) => Promise<boolean>;
};

export type ReconfigureResult =
  | { ok: true; alreadyReopened: boolean }
  | { ok: false; status: number; error: string };

type Row = {
  id: string;
  mode: string;
  user_id: string;
  status: string;
  error_message: string | null;
  long_form_confirmed_at: string | null;
  reel_image_source?: string | null;
};

async function download(service: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await service.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  return await data.text();
}

function defaultDeps(service: SupabaseClient): Required<ReconfigureDeps> {
  return {
    async listOperations(requestId) {
      const ledger = supabaseLedgerStore(service);
      if (!ledger.listByProjects) throw new Error("el ledger no permite listar operaciones");
      return ledger.listByProjects([requestId]);
    },
    async loadBudget(requestId) {
      const text = await download(service, productionBudgetPath(requestId));
      return text ? (JSON.parse(text) as ProductionBudgetState) : null;
    },
    async removeBudget(requestId) {
      const { error } = await service.storage.from(BUCKET).remove([productionBudgetPath(requestId)]);
      if (error) throw new Error(error.message);
    },
    async authorizationExists(requestId) {
      return Boolean(await download(service, `${requestId}/state/request-budget.json`));
    },
  };
}

const NOT_ELIGIBLE = "Solo se puede volver a configurar un documental detenido por falta de material antes de gastar. No se cambió nada.";

export async function reopenLongFormAfterMaterialGap(
  service: SupabaseClient,
  input: { requestId: string; userId: string },
  deps: ReconfigureDeps = {},
): Promise<ReconfigureResult> {
  const d = { ...defaultDeps(service), ...deps };
  const { data, error } = await service.from("video_requests")
    .select("id, mode, user_id, status, error_message, long_form_confirmed_at, reel_image_source")
    .eq("id", input.requestId)
    .maybeSingle<Row>();
  if (error) return { ok: false, status: 503, error: "No se pudo leer la solicitud. No se cambió nada." };
  if (!data) return { ok: false, status: 404, error: "Solicitud no encontrada" };
  if (data.user_id !== input.userId) return { ok: false, status: 403, error: "No autorizado" };
  if (data.mode !== "long_form") return { ok: false, status: 409, error: "Esta solicitud no es de Long Form" };
  // Idempotent: already back in Configure (a double click, or a second tab).
  if (data.status === "script_ready" && !data.long_form_confirmed_at) return { ok: true, alreadyReopened: true };
  if (data.status !== "failed" || !data.long_form_confirmed_at || !isMaterialUnavailableFailure(data.error_message)) {
    return { ok: false, status: 409, error: NOT_ELIGIBLE };
  }
  if (data.reel_image_source === "recraft") {
    return { ok: false, status: 409, error: "Este documental tiene fijadas las imágenes de Recraft; no puede volver a configurarse desde aquí. Contacta al soporte. No se cambió nada." };
  }

  // Zero production spend, proven from the ledger and the durable production state (never assumed from the message).
  let ops: PaidOperation[];
  let budget: ProductionBudgetState | null;
  let authorized: boolean;
  try {
    [ops, budget, authorized] = await Promise.all([d.listOperations(input.requestId), d.loadBudget(input.requestId), d.authorizationExists(input.requestId)]);
  } catch {
    return { ok: false, status: 503, error: "No se pudo comprobar el gasto de producción de este documental. No se cambió nada; inténtalo de nuevo." };
  }
  const production = productionOps(ops);
  if (production.some((op) => op.status !== "REFUNDED") || requestSpend(production).totalUsd > 0) {
    return { ok: false, status: 409, error: "Este documental ya tiene operaciones de producción registradas; no puede volver a configurarse. Contacta al soporte. No se cambió nada." };
  }
  const used = budget?.used;
  if (used && (used.aiImageGenerations > 0 || used.aiVideoSubmits > 0 || used.generativeUsd > 0 || (used.spentUsd ?? 0) > 0)) {
    return { ok: false, status: 409, error: "El presupuesto de producción de este documental registra uso; no puede volver a configurarse. Contacta al soporte. No se cambió nada." };
  }
  if (authorized) {
    return { ok: false, status: 409, error: "Este documental ya tiene un presupuesto total autorizado; no puede volver a configurarse desde aquí. Contacta al soporte. No se cambió nada." };
  }

  // The stored production budget only holds the old allocation (unused). ProductionBudget.open never widens it, so a
  // new plan with more AI images would be clamped to the old one: remove it BEFORE the transition (a lost race leaves
  // a failed request without an unused file, which the next attempt recreates from its confirmed plan).
  if (budget) {
    try {
      await d.removeBudget(input.requestId);
    } catch {
      return { ok: false, status: 503, error: "No se pudo preparar el documental para volver a configurarlo. No se cambió nada; inténtalo de nuevo." };
    }
  }

  const { data: updated, error: updateError } = await service.from("video_requests")
    .update({ status: "script_ready", long_form_confirmed_at: null, long_form_production_plan: null, error_message: null,
      progress_stage: null, long_form_stage: null, long_form_progress: null })
    .eq("id", input.requestId)
    .eq("user_id", input.userId)
    .eq("status", "failed")
    .eq("long_form_confirmed_at", data.long_form_confirmed_at)
    .eq("error_message", data.error_message)
    .select("id")
    .maybeSingle<{ id: string }>();
  if (updateError) return { ok: false, status: 503, error: "No se pudo volver a configurar el documental. No se cambió nada; inténtalo de nuevo." };
  if (updated) return { ok: true, alreadyReopened: false };
  // Lost the race: either another click already reopened it (idempotent) or the state changed (e.g. a retry started).
  const { data: now } = await service.from("video_requests").select("status, long_form_confirmed_at").eq("id", input.requestId)
    .maybeSingle<{ status: string; long_form_confirmed_at: string | null }>();
  if (now?.status === "script_ready" && !now.long_form_confirmed_at) return { ok: true, alreadyReopened: true };
  return { ok: false, status: 409, error: "El estado del documental cambió justo ahora. No se cambió nada." };
}
