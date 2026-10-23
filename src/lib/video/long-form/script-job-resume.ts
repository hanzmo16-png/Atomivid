import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Owner-authorised resume of ONE failed documentary script job after a deployed fix (2026-10-23, job e8048599:
 * the visual plan of block 6 failed with 150fb502 after the job had used its 3 technical retries, so the app no
 * longer offers «Reintentar»). Nothing is generated here and no paid call is made: the job is put back in the
 * queue and the normal worker replays every COMMITTED response from the ledger for free; only stages that never
 * produced a response may call a provider (under the usual supply controls).
 *
 * Fail-closed preconditions, all on the CURRENT row: failed + technical, the exact error code and retry count the
 * owner saw, a saved checkpoint, no live run token, and a compare-and-swap on updated_at. retry_count is kept
 * (audit trail; >0 also keeps the one-scene visual repair available). The authorisation is a typed confirmation.
 */
export type ResumeRequest = { jobId: string; expectedErrorCode: string; expectedRetryCount: number; confirm: string };
export type ResumeRow = { id: string; status: string; failure_kind: string | null; error_code: string | null; retry_count: number; run_token: string | null; updated_at: string; editorial_checkpoint: unknown };

export function resumeConfirmation(jobId: string): string { return `RESUME-${jobId.slice(0, 8)}`; }

export function resumeRefusal(req: ResumeRequest, row: ResumeRow | null): string | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(req.jobId)) return "invalid job id";
  if (req.confirm !== resumeConfirmation(req.jobId)) return "missing or wrong confirmation";
  if (!row) return "job not found";
  if (row.status !== "failed") return `job is ${row.status}, not failed`;
  if (row.failure_kind !== "technical") return "only technical failures can be resumed this way";
  if (row.error_code !== req.expectedErrorCode) return "error code changed since it was reviewed";
  if (row.retry_count !== req.expectedRetryCount) return "retry count changed since it was reviewed";
  if (row.run_token) return "a run token is still present";
  if (!row.editorial_checkpoint) return "no saved checkpoint";
  return null;
}

export async function resumeScriptJob(service: SupabaseClient, req: ResumeRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await service.from("documentary_script_jobs")
    .select("id,status,failure_kind,error_code,retry_count,run_token,updated_at,editorial_checkpoint").eq("id", req.jobId).maybeSingle();
  if (error) return { ok: false, reason: "job read failed" };
  const refusal = resumeRefusal(req, data as ResumeRow | null);
  if (refusal) return { ok: false, reason: refusal };
  const row = data as ResumeRow;
  const { data: updated, error: updateError } = await service.from("documentary_script_jobs")
    .update({ status: "queued", run_token: null, failure_kind: null, error_code: null, error_message: null, stage: "En cola", updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "failed").eq("updated_at", row.updated_at).select("id");
  if (updateError || updated?.length !== 1) return { ok: false, reason: "the job changed concurrently; nothing was modified" };
  return { ok: true };
}
