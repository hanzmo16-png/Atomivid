/**
 * Whether a failed (or stale) avatar request can be recovered, decided from the REAL state of the
 * request and its paid ledger — the single rule used by the history card, the review page and the
 * render route (which enforces it). Never "retry everything": a request whose provider work was
 * submitted, is uncertain or already charged must recover/reconcile THAT work, not pay again.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";

/** Ledger states that prove (or may mean) the provider received the call. */
export const PROVIDER_TOUCHED_STATUSES = ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "COMMITTED"] as const;

export type AvatarRecoveryRow = { status: string; render_attempts: number; avatar_provider_video_job_id: string | null; video_path: string | null };
export type AvatarLedgerOp = { status: string; method: string; provider_job_id: string | null };

export type AvatarRecovery =
  | { action: "retry"; label: string; note: string }
  | { action: "recover_provider_job"; label: string; note: string }
  | { action: "none"; reason: "completed" | "reconcile" | "paid_result_missing" | "exhausted" | "not_failed"; message: string };

export function decideAvatarRecovery(row: AvatarRecoveryRow, ops: AvatarLedgerOp[]): AvatarRecovery {
  if (row.video_path) return { action: "none", reason: "completed", message: "Este video ya está listo." };
  if (row.render_attempts >= MAX_RENDER_ATTEMPTS)
    return { action: "none", reason: "exhausted", message: `Se alcanzó el máximo de ${MAX_RENDER_ATTEMPTS} intentos. Crea una solicitud nueva.` };
  // The provider already accepted a video for this request: fetch THAT result; never request another one.
  if (row.avatar_provider_video_job_id)
    return { action: "recover_provider_job", label: "Recuperar video", note: "HeyGen ya aceptó este video: se recupera el resultado existente, sin pedir ni cobrar otro." };
  const uncertain = ops.find((o) => o.status === "SUBMITTED" || o.status === "RECONCILIATION_REQUIRED");
  if (uncertain)
    return { action: "none", reason: "reconcile", message: "Hay un envío al proveedor con resultado incierto. Para no cobrar dos veces, debe conciliarse antes de reintentar; contacta a soporte." };
  const touched = ops.find((o) => (PROVIDER_TOUCHED_STATUSES as readonly string[]).includes(o.status) || o.provider_job_id);
  if (touched)
    return { action: "none", reason: "paid_result_missing", message: "El proveedor ya procesó un envío de esta solicitud. Para no pagar otro video, su resultado debe recuperarse antes; contacta a soporte." };
  return { action: "retry", label: "Reintentar", note: "Se reutilizan la misma foto y grabación. No se había enviado nada al proveedor, así que no hay cobro previo que repetir." };
}

/** Recovery for a request the caller already authorized (owner check done by the caller). Read errors fail closed. */
export async function loadAvatarRecovery(service: SupabaseClient, requestId: string, row: AvatarRecoveryRow): Promise<AvatarRecovery> {
  const { data, error } = await service.from("pi_paid_operations").select("status,method,provider_job_id").eq("project_id", requestId);
  if (error || !data) return { action: "none", reason: "reconcile", message: "No se pudo comprobar el historial de cobros de esta solicitud. Vuelve a intentarlo en un momento." };
  return decideAvatarRecovery(row, data as AvatarLedgerOp[]);
}

/** Batch version for the history page: one ledger query for every failed/stale avatar request. */
export async function loadAvatarRecoveries(service: SupabaseClient, rows: (AvatarRecoveryRow & { id: string })[]): Promise<Map<string, AvatarRecovery>> {
  const out = new Map<string, AvatarRecovery>();
  if (!rows.length) return out;
  const { data, error } = await service.from("pi_paid_operations").select("project_id,status,method,provider_job_id").in("project_id", rows.map((r) => r.id));
  for (const r of rows) {
    out.set(r.id, error || !data
      ? { action: "none", reason: "reconcile", message: "No se pudo comprobar el historial de cobros de esta solicitud. Vuelve a cargar la página." }
      : decideAvatarRecovery(r, (data as (AvatarLedgerOp & { project_id: string })[]).filter((o) => o.project_id === r.id)));
  }
  return out;
}
