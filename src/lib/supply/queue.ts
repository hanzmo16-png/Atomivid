import type { SupabaseClient } from "@supabase/supabase-js";
import { supplyGuardRequired } from "./server";
import { reserveJobSupply, jobSupplyDemands, JobEnvelopeMismatchError } from "./job";
import { getVoiceProvider } from "@/lib/providers/voice";
import { SupplyUnavailableError } from "./policy";

/** Only previously user-started work. Same attempt; no new permission, quota or paid retry. */
export async function resumeSupplyQueue(service: SupabaseClient, trigger: (input: { requestId: string; renderAttempt: number; mode: string }) => Promise<void>, now = Date.now()): Promise<number> {
  if (supplyGuardRequired()) {
    const { data: slots, error: slotError } = await service.rpc("pi_worker_supply_slots");
    if (slotError || !slots?.configured || !(slots.free > 0)) return 0;
  }
  const { data, error } = await service.from("video_requests")
    .select(QUEUED_COLUMNS)
    .eq("status", "processing").eq("progress_stage", "queued")
    .not("supply_wait_started_at", "is", null).lte("supply_not_before", new Date(now).toISOString())
    .order("supply_wait_started_at").limit(3);
  if (error) throw new Error("SUPPLY_QUEUE_UNAVAILABLE");
  let dispatched = 0;
  for (const row of data ?? []) {
    try {
      if ((await resumeRow(service, row as QueuedRow, trigger, now)) === "dispatched") dispatched++;
    } catch (error) {
      // Configuration inconsistency: never re-dispatch it (it would fail again); the others still resume.
      if (error instanceof JobEnvelopeMismatchError) { console.error(`[atomivid:supply] envelope mismatch on ${error.provider}; not resumed`); continue; }
      throw error;
    }
  }
  return dispatched;
}

type QueuedRow = { id: string; mode: string | null; render_attempts: number; supply_wait_started_at: string; script_json: unknown; recorded_audio_path: string | null; long_form_production_plan: unknown };
export type ResumeOutcome = "dispatched" | "frozen" | "uncertain_paid_call" | "supply_unavailable" | "already_claimed";
const QUEUED_COLUMNS = "id,mode,render_attempts,supply_wait_started_at,script_json,recorded_audio_path,long_form_production_plan";

/**
 * One previously user-started request waiting for supply: same attempt, same envelope, no new permission,
 * quota or paid retry. The claim (supply_not_before pushed 10 min ahead, compare-and-set on the read row)
 * makes the cron and the owner's "Reanudar" button mutually exclusive: only one dispatch per window.
 */
async function resumeRow(service: SupabaseClient, row: QueuedRow, trigger: (input: { requestId: string; renderAttempt: number; mode: string }) => Promise<void>, now: number): Promise<ResumeOutcome> {
  // Private one-request grants are frozen; the general queue must never replay them.
  const { data: ops, error: opError } = await service.from("pi_paid_operations").select("idempotency_key,status")
    .eq("project_id", row.id);
  if (opError) throw new Error("SUPPLY_QUEUE_LEDGER_UNAVAILABLE");
  if ((ops ?? []).some(op => op.idempotency_key === `owner_form_trial:${row.id}` || op.idempotency_key === `owner_pilot_grant:${row.id}`)) return "frozen";
  if ((ops ?? []).some(op => ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(op.status))) return "uncertain_paid_call";
  try { await reserveJobSupply(service, row.id, row.render_attempts, jobSupplyDemands(row as never, getVoiceProvider().name)); }
  catch (error) {
    if (error instanceof SupplyUnavailableError) return "supply_unavailable";
    throw error;
  }
  const { data: claimed, error: claimError } = await service.from("video_requests")
    .update({ supply_not_before: new Date(now + 600_000).toISOString() })
    .eq("id", row.id).eq("status", "processing").eq("progress_stage", "queued")
    .eq("render_attempts", row.render_attempts).eq("supply_wait_started_at", row.supply_wait_started_at)
    .lte("supply_not_before", new Date(now).toISOString()).select("id").maybeSingle();
  if (claimError) throw new Error("SUPPLY_QUEUE_CLAIM_UNAVAILABLE");
  if (!claimed) return "already_claimed";
  await trigger({ requestId: row.id, renderAttempt: row.render_attempts, mode: row.mode ?? "visual" });
  return "dispatched";
}

/**
 * Owner-initiated resume of ONE waiting request (the "Reanudar ahora" action). Ownership is checked by the
 * caller; this only acts on a row that is still waiting for supply and whose retry window has opened.
 */
export async function resumeSupplyRequest(service: SupabaseClient, requestId: string, userId: string,
  trigger: (input: { requestId: string; renderAttempt: number; mode: string }) => Promise<void>, now = Date.now()): Promise<ResumeOutcome | "not_waiting" | "too_soon"> {
  const { data, error } = await service.from("video_requests").select(`${QUEUED_COLUMNS},status,progress_stage,supply_not_before`)
    .eq("id", requestId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("SUPPLY_QUEUE_UNAVAILABLE");
  const row = data as (QueuedRow & { status: string; progress_stage: string | null; supply_not_before: string | null }) | null;
  if (!row || row.status !== "processing" || row.progress_stage !== "queued" || !row.supply_wait_started_at) return "not_waiting";
  if (row.supply_not_before && Date.parse(row.supply_not_before) > now) return "too_soon";
  return resumeRow(service, row, trigger, now);
}
