import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseUnusedJobSupply } from "@/lib/supply/job";
import { encodeStoredFailure } from "./failure-action";
import { generateDiagnosticId } from "./render-error";
import { canCancelReel, REEL_CANCELLED_MESSAGE, type CancellableRow } from "./reel-cancel";

/** Compare-and-set processing → failed («retry») on the same attempt and stage; see reel-cancel.ts. */
export async function cancelReelAttempt(service: SupabaseClient, row: CancellableRow): Promise<"cancelled" | "not_cancellable" | "changed"> {
  if (!canCancelReel(row)) return "not_cancellable";
  const message = encodeStoredFailure(`${REEL_CANCELLED_MESSAGE} (Código: ${generateDiagnosticId()})`, "retry");
  let query = service.from("video_requests")
    .update({ status: "failed", progress_stage: null, error_message: message, supply_wait_started_at: null, supply_not_before: null })
    .eq("id", row.id).eq("user_id", row.user_id).eq("mode", "visual").eq("status", "processing").eq("render_attempts", row.render_attempts);
  query = row.progress_stage === null ? query.is("progress_stage", null) : query.eq("progress_stage", row.progress_stage);
  const result = await query.select("id");
  if (result.error) throw result.error;
  if (!result.data?.length) return "changed";
  // Only a job no worker is running (never claimed, or parked waiting for capacity) releases its reservation here.
  // A running worker releases it itself at its next checkpoint (run-job.ts), so a call in flight keeps its envelope.
  if (row.progress_stage === null || row.progress_stage === "queued") {
    await releaseUnusedJobSupply(service, row.id, row.render_attempts).catch(() => undefined);
  }
  return "cancelled";
}
