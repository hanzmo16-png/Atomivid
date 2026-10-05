import type { SupabaseClient } from "@supabase/supabase-js";
import { supplyGuardRequired } from "./server";
import { reserveJobSupply, jobSupplyDemands } from "./job";
import { getVoiceProvider } from "@/lib/providers/voice";
import { SupplyUnavailableError } from "./policy";

/** Only previously user-started work. Same attempt; no new permission, quota or paid retry. */
export async function resumeSupplyQueue(service: SupabaseClient, trigger: (input: { requestId: string; renderAttempt: number; mode: string }) => Promise<void>, now = Date.now()): Promise<number> {
  if (supplyGuardRequired()) {
    const { data: slots, error: slotError } = await service.rpc("pi_worker_supply_slots");
    if (slotError || !slots?.configured || !(slots.free > 0)) return 0;
  }
  const { data, error } = await service.from("video_requests")
    .select("id,mode,render_attempts,supply_wait_started_at,script_json,recorded_audio_path,long_form_production_plan")
    .eq("status", "processing").eq("progress_stage", "queued")
    .not("supply_wait_started_at", "is", null).lte("supply_not_before", new Date(now).toISOString())
    .order("supply_wait_started_at").limit(3);
  if (error) throw new Error("SUPPLY_QUEUE_UNAVAILABLE");
  let dispatched = 0;
  for (const row of data ?? []) {
    // Private one-request grants are frozen; the general queue must never replay them.
    const { data: ops, error: opError } = await service.from("pi_paid_operations").select("idempotency_key,status")
      .eq("project_id", row.id);
    if (opError) throw new Error("SUPPLY_QUEUE_LEDGER_UNAVAILABLE");
    if ((ops ?? []).some(op => op.idempotency_key === `owner_form_trial:${row.id}`
      || op.idempotency_key === `owner_pilot_grant:${row.id}`
      || ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(op.status))) continue;
    try { await reserveJobSupply(service, row.id, row.render_attempts, jobSupplyDemands(row, getVoiceProvider().name)); }
    catch (error) { if (error instanceof SupplyUnavailableError) continue; throw error; }
    const { data: claimed, error: claimError } = await service.from("video_requests")
      .update({ supply_not_before: new Date(now + 600_000).toISOString() })
      .eq("id", row.id).eq("status", "processing").eq("progress_stage", "queued")
      .eq("render_attempts", row.render_attempts).eq("supply_wait_started_at", row.supply_wait_started_at)
      .lte("supply_not_before", new Date(now).toISOString()).select("id").maybeSingle();
    if (claimError) throw new Error("SUPPLY_QUEUE_CLAIM_UNAVAILABLE");
    if (!claimed) continue;
    await trigger({ requestId: row.id, renderAttempt: row.render_attempts, mode: row.mode ?? "visual" });
    dispatched++;
  }
  return dispatched;
}
