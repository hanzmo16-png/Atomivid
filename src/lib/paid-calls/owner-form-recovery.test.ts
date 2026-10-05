import test from "node:test";
import assert from "node:assert/strict";
import type { LedgerStore, PaidOperation } from "./gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerFormTrial } from "@/lib/billing/owner-form-trial";
import { skipKnownIncompleteCandidate, KnownIncompleteCandidateError, INCOMPLETE_REVIEW, RECOVERY_REQUEST, RECOVERY_AUTH, RECOVERY_RUN, RecoverySchema, recoveryLedger } from "./owner-form-recovery";

const grant = { version: "owner-form-recovery/1", requestId: RECOVERY_REQUEST, ownerId: "d2064950-7a95-4208-8dfb-d93b470d141d",
  scriptSha: "55b44c3c552c52f69fc9bd5818afd643098d88d9cfea708900ddcc670832a4b0", blockedReviewKey: INCOMPLETE_REVIEW,
  expiresAt: "2026-10-07T23:00:00Z", maxAccountedUsd: 1.25, authorization: "2026-10-04:deploy-correction-complete-test",
  deployedCommit: "16e541ff4aef67e3ccb5708bd54b90b304ffc6e6", deploymentId: "dpl_24iG6ffUEgW3Dk32kwQ1t4usG4WE" };

test("recovery skips only the named incomplete candidate and performs zero writes", async () => {
  let writes = 0;
  const row: PaidOperation = { idempotencyKey: INCOMPLETE_REVIEW, projectId: RECOVERY_REQUEST, shotId: "visual-review:scene-0", provider: "openai",
    model: "gpt-4.1-mini-2025-04-14", method: "visual_relevance_review", attemptKind: "initial", reservedUsd: 0.005,
    status: "RECONCILIATION_REQUIRED", committedUsd: null, resultRef: null, providerJobId: null, updatedAt: "2026-10-05T00:00:00Z" };
  const base: LedgerStore = { get: async key => key === INCOMPLETE_REVIEW ? row : null,
    insert: async () => { writes++; return true; }, update: async () => { writes++; return true; } };
  const wrapped = skipKnownIncompleteCandidate(base);
  await assert.rejects(wrapped.get(INCOMPLETE_REVIEW), KnownIncompleteCandidateError);
  assert.equal(await wrapped.get("different-candidate"), null);
  assert.equal(writes, 0); assert.equal(row.status, "RECONCILIATION_REQUIRED");
  row.status = "SUBMITTED";
  await assert.rejects(wrapped.get(INCOMPLETE_REVIEW), /REVIEW_CHANGED/);
});

test("a recovery receipt cannot authorize another request, script, review or larger budget", () => {
  assert.ok(RecoverySchema.safeParse(grant).success);
  for (const patch of [{ requestId: "other" }, { ownerId: "other" }, { scriptSha: "changed" }, { blockedReviewKey: "other" },
    { maxAccountedUsd: 2 }, { maxRenderAttempts: 2 }, { authorization: "old permission" }]) {
    assert.equal(RecoverySchema.safeParse({ ...grant, ...patch }).success, false);
  }
});

test("recovery requires the exact active run and saved truncation evidence; unknown failures cannot be skipped", async () => {
  const keys = ["OWNER_FORM_RECOVERY_WORKER", "GITHUB_ACTIONS", "GITHUB_RUN_ID"];
  const old = keys.map(k => process.env[k]);
  try {
    process.env.OWNER_FORM_RECOVERY_WORKER = "true"; process.env.GITHUB_ACTIONS = "true"; process.env.GITHUB_RUN_ID = "123";
    const common = { project_id: RECOVERY_REQUEST, provider: "internal", model: "internal", attempt_kind: "initial", reserved_usd: 0,
      committed_usd: 0, status: "COMMITTED", shot_id: "internal", provider_job_id: null, result_ref: null, updated_at: "2026-10-05T00:00:00Z" };
    const rows: Record<string, Record<string, unknown>> = {
      [RECOVERY_AUTH]: { ...common, idempotency_key: RECOVERY_AUTH, method: "human_direction", result_ref: JSON.stringify(grant) },
      [`owner_form_render:${RECOVERY_REQUEST}`]: { ...common, method: "freeze_reviewed_script", result_ref: grant.scriptSha },
      [RECOVERY_RUN]: { ...common, method: "resume_incomplete_visual_trial", status: "SUBMITTED", provider_job_id: "123" },
      [INCOMPLETE_REVIEW]: { ...common, provider: "openai", model: "gpt-4.1-mini-2025-04-14", method: "visual_relevance_review",
        status: "RECONCILIATION_REQUIRED", reserved_usd: 0.005, shot_id: "visual-review:scene-0" },
    };
    let reason = "max_output_tokens", reads = 0;
    const service = { from() { let key = ""; const query = { select() { return query; }, eq(_field: string, value: string) { key = value; return query; },
      maybeSingle: async () => ({ data: rows[key] ?? null, error: null }) }; return query; },
      storage: { from() { return { download: async () => { reads++; return { data: new Blob([JSON.stringify({ status: "incomplete", incomplete_details: { reason } })]), error: null }; } }; } },
    } as unknown as SupabaseClient;
    const trial = { requestId: RECOVERY_REQUEST, ownerId: grant.ownerId, expiresAt: grant.expiresAt } as OwnerFormTrial;
    const base: LedgerStore = { get: async () => null, insert: async () => { throw Error("No writes expected"); }, update: async () => { throw Error("No writes expected"); } };
    await recoveryLedger(service, trial, base); assert.equal(reads, 1);
    rows[RECOVERY_RUN].provider_job_id = "other-run";
    await assert.rejects(recoveryLedger(service, trial, base), /RUN_NOT_CLAIMED/); assert.equal(reads, 1);
    rows[RECOVERY_RUN].provider_job_id = "123"; reason = "unknown";
    await assert.rejects(recoveryLedger(service, trial, base), /CAUSE_UNVERIFIED/);
    rows[`owner_form_render:${RECOVERY_REQUEST}`].result_ref = "changed";
    await assert.rejects(recoveryLedger(service, trial, base), /SCRIPT_CHANGED/);
  } finally { keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }); }
});
