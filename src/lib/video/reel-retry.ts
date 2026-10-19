import { describeStoredFailure } from "./job-error";
import { hasRenderableScript } from "./own-script";
import { evaluateRenderStart, isRenderStale, type RenderStartRow } from "./render-guard";

/**
 * Only a recoverable visual Reel with an already prepared script may offer an explicit
 * retry from review. The review asks for fresh confirmation of any Director material
 * ceiling. This is an availability hint, never permission to spend: POST /render
 * re-checks ownership, stale state, quotas, admission and the atomic attempt CAS.
 */
export type ReviewableReelRow = RenderStartRow & {
  script_json: unknown;
  error_message?: string | null;
};

export function canReviewReelRetry(row: ReviewableReelRow, nowMs: number): boolean {
  if (row.mode !== "visual" || !hasRenderableScript(row.script_json)) return false;
  if (row.status !== "failed" && !isRenderStale(row, nowMs)) return false;
  if (row.status === "failed" && row.error_message && describeStoredFailure(row.error_message).action === "support") return false;
  return evaluateRenderStart(row, nowMs).allowed;
}
