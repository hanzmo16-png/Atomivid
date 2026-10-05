import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerFormTrial } from "@/lib/billing/owner-form-trial";
import type { LedgerStore } from "./gate";
import { supabaseLedgerStore } from "./supabase-ledger-store";
import { supabaseResultStore } from "./result-store";

export const RECOVERY_REQUEST = "34bc43f3-a53d-4daa-b8fa-bef3f1544b04";
export const INCOMPLETE_REVIEW = "op_4fc34fd2dce2a934b1501e074620652d";
export const RECOVERY_AUTH = `owner_form_recovery_authorization:${RECOVERY_REQUEST}`;
export const RECOVERY_RUN = `owner_form_recovery_execution:${RECOVERY_REQUEST}`;
export const SECOND_INCOMPLETE_REVIEW = "op_9dd941e5dcc6feb9dbee3d11a745fb17";
export function activeRecoveryKeys() {
  const compact = process.env.OWNER_FORM_RECOVERY_STAGE === "compact-final";
  return { compact, authorization: compact ? RECOVERY_AUTH + ":compact-final" : RECOVERY_AUTH,
    execution: compact ? RECOVERY_RUN + ":compact-final" : RECOVERY_RUN };
}
export const RecoverySchema = z.object({
  version: z.literal("owner-form-recovery/1"), requestId: z.literal(RECOVERY_REQUEST),
  ownerId: z.literal("d2064950-7a95-4208-8dfb-d93b470d141d"),
  scriptSha: z.literal("55b44c3c552c52f69fc9bd5818afd643098d88d9cfea708900ddcc670832a4b0"),
  blockedReviewKey: z.literal(INCOMPLETE_REVIEW), expiresAt: z.string().datetime(),
  deployedCommit: z.literal("16e541ff4aef67e3ccb5708bd54b90b304ffc6e6"),
  deploymentId: z.literal("dpl_24iG6ffUEgW3Dk32kwQ1t4usG4WE"),
  maxAccountedUsd: z.literal(1.25), authorization: z.literal("2026-10-04:deploy-correction-complete-test"),
}).strict();
export const CompactRecoverySchema = RecoverySchema.extend({ version: z.literal("owner-form-recovery/2"),
  additionalBlockedReviewKey: z.literal(SECOND_INCOMPLETE_REVIEW), preferIllustrations: z.literal(true) }).strict();

/** A known, unusable candidate may be skipped, never accepted or bought again. */
export class KnownIncompleteCandidateError extends Error {
  constructor() { super("La revisión guardada quedó incompleta; este candidato no se acepta ni se vuelve a cobrar."); }
}

export async function readRecovery(service: SupabaseClient, trial: OwnerFormTrial) {
  const keys = activeRecoveryKeys();
  const receipt = await supabaseLedgerStore(service).get(keys.authorization);
  if (!receipt || receipt.status !== "COMMITTED" || receipt.projectId !== trial.requestId
    || receipt.provider !== "internal" || receipt.method !== "human_direction"
    || receipt.reservedUsd !== 0 || receipt.committedUsd !== 0 || !receipt.resultRef) throw Error("RECOVERY_AUTH_REQUIRED");
  const grant = (keys.compact ? CompactRecoverySchema : RecoverySchema).parse(JSON.parse(receipt.resultRef));
  if (trial.requestId !== grant.requestId || trial.ownerId !== grant.ownerId
    || Date.parse(grant.expiresAt) <= Date.now() || Date.parse(grant.expiresAt) > Date.parse(trial.expiresAt)) throw Error("RECOVERY_SCOPE_BLOCKED");
  const frozen = await supabaseLedgerStore(service).get(`owner_form_render:${trial.requestId}`);
  if (!frozen || frozen.status !== "COMMITTED" || frozen.projectId !== trial.requestId || frozen.provider !== "internal"
    || frozen.method !== "freeze_reviewed_script" || frozen.resultRef !== grant.scriptSha) throw Error("RECOVERY_SCRIPT_CHANGED");
  return grant;
}

export async function verifyIncompleteReview(service: SupabaseClient, key = INCOMPLETE_REVIEW) {
  if (![INCOMPLETE_REVIEW, SECOND_INCOMPLETE_REVIEW].includes(key)) throw Error("RECOVERY_REVIEW_SCOPE_BLOCKED");
  const op = await supabaseLedgerStore(service).get(key);
  if (!op || op.projectId !== RECOVERY_REQUEST || op.shotId !== (key === INCOMPLETE_REVIEW ? "visual-review:scene-0" : "visual-review:scene-2")
    || op.status !== "RECONCILIATION_REQUIRED" || op.provider !== "openai"
    || op.model !== "gpt-4.1-mini-2025-04-14" || op.method !== "visual_relevance_review"
    || op.reservedUsd !== 0.005) throw Error("RECOVERY_REVIEW_STATE_BLOCKED");
  const raw = await supabaseResultStore(service).getJson<{ status?: string; incomplete_details?: { reason?: string } }>(
    `${RECOVERY_REQUEST}/paid/${key}.json.provider-response.json`);
  if (raw?.status !== "incomplete" || raw.incomplete_details?.reason !== "max_output_tokens") throw Error("RECOVERY_CAUSE_UNVERIFIED");
}

export function skipKnownIncompleteCandidate(base: LedgerStore, blockedKeys = [INCOMPLETE_REVIEW]): LedgerStore {
  return { ...base, async get(key) {
    const op = await base.get(key);
    if (blockedKeys.includes(key)) {
      if (!op || op.projectId !== RECOVERY_REQUEST || op.status !== "RECONCILIATION_REQUIRED") throw Error("RECOVERY_REVIEW_CHANGED");
      throw new KnownIncompleteCandidateError();
    }
    return op;
  } };
}

/** Available only to the once-consumed recovery run, not HTTP admission or other trials. */
export async function recoveryLedger(service: SupabaseClient, trial: OwnerFormTrial, base: LedgerStore) {
  if (process.env.OWNER_FORM_RECOVERY_WORKER !== "true" || !process.env.GITHUB_ACTIONS || !process.env.GITHUB_RUN_ID) throw Error("RECOVERY_ISOLATION_REQUIRED");
  await readRecovery(service, trial);
  const keys = activeRecoveryKeys();
  const execution = await supabaseLedgerStore(service).get(keys.execution);
  if (!execution || execution.projectId !== trial.requestId || execution.provider !== "internal"
    || execution.method !== "resume_incomplete_visual_trial" || execution.status !== "SUBMITTED"
    || execution.reservedUsd !== 0 || execution.providerJobId !== process.env.GITHUB_RUN_ID) throw Error("RECOVERY_RUN_NOT_CLAIMED");
  await verifyIncompleteReview(service);
  if (keys.compact) await verifyIncompleteReview(service, SECOND_INCOMPLETE_REVIEW);
  return skipKnownIncompleteCandidate(base, keys.compact ? [INCOMPLETE_REVIEW, SECOND_INCOMPLETE_REVIEW] : [INCOMPLETE_REVIEW]);
}
