/**
 * Recovery classifier: on resume/retry, decide per shot what EXISTS, what is VALID, what
 * must be REGENERATED and what can be REUSED, from three existing sources of truth:
 * the lifecycle state (state-machine.ts), the paid-operation ledger (ledger.ts) and the
 * durable asset records (durable-shot-assets.ts). It never charges, never regenerates a
 * valid asset and never resubmits an in-flight provider job.
 */
import type { PaidOperation } from "../production-intelligence/ledger";
import type { ShotAssetRecord } from "../video/long-form/durable-shot-assets";
import type { ProductionShotRecord } from "./shot-record";

export type RecoveryAction = "REUSE" | "RESUME_IN_FLIGHT" | "GENERATE" | "REGENERATE" | "RECONCILE" | "HUMAN_REVIEW" | "SKIP_CANCELLED";
export type RecoveryDecision = { shotId: string; action: RecoveryAction; exists: boolean; valid: boolean; reasons: string[] };

export function classifyForRecovery(r: ProductionShotRecord, ops: PaidOperation[], assets: ShotAssetRecord[]): RecoveryDecision {
  const id = r.contract.shotId;
  const reasons: string[] = [];
  const completed = assets.filter((a) => a.shotId === id && a.status === "COMPLETED" && a.objectPath);
  const myOps = ops.filter((o) => o.shotId === id);
  const inFlight = myOps.find((o) => o.status === "PROVIDER_JOB_RECORDED");
  const ambiguous = myOps.find((o) => o.status === "SUBMITTED" || o.status === "RECONCILIATION_REQUIRED");
  const done = (a: RecoveryAction, exists: boolean, valid: boolean) => ({ shotId: id, action: a, exists, valid, reasons });

  if (r.lifecycleState === "CANCELLED") { reasons.push("cancelled: no new spend ever"); return done("SKIP_CANCELLED", completed.length > 0, false); }
  if (ambiguous) { reasons.push(`paid operation ${ambiguous.idempotencyKey} is ${ambiguous.status}: provider may have accepted; never resubmitted`); return done("RECONCILE", false, false); }
  if (inFlight) { reasons.push(`provider job ${inFlight.providerJobId} recorded: resume polling, no new submission`); return done("RESUME_IN_FLIGHT", false, false); }
  if (r.contract.existingApprovedAssetId) { reasons.push(`existing approved asset ${r.contract.existingApprovedAssetId} (R12): reuse at USD 0`); return done("REUSE", true, true); }
  const validStates = new Set(["STILL_APPROVED", "LOCKED", "RENDERED", "DELIVERED"]);
  if (completed.length && validStates.has(r.lifecycleState) && r.qaStatus !== "FAIL") { reasons.push(`asset ${completed[0].objectPath} exists and QA is ${r.qaStatus}: reuse`); return done("REUSE", true, true); }
  if (completed.length && (r.qaStatus === "FAIL" || r.lifecycleState === "STILL_FAILED" || r.lifecycleState === "MOTION_FAILED")) {
    if (r.fallbackState === "HUMAN_REVIEW") { reasons.push("failed and marked for human review"); return done("HUMAN_REVIEW", true, false); }
    reasons.push(`asset exists but ${r.lifecycleState}/${r.qaStatus}: regenerate under a NEW idempotency key (materially different attempt)`); return done("REGENERATE", true, false);
  }
  if (completed.length) { reasons.push(`asset exists in ${r.lifecycleState} without QA: reuse the bytes, run QA (no regeneration)`); return done("REUSE", true, false); }
  reasons.push("no asset, no in-flight job: generate");
  return done("GENERATE", false, false);
}

export function recoveryPlan(records: ProductionShotRecord[], ops: PaidOperation[], assets: ShotAssetRecord[]) {
  const decisions = records.map((r) => classifyForRecovery(r, ops, assets));
  const count = (a: RecoveryAction) => decisions.filter((d) => d.action === a).length;
  return { decisions, summary: { reuse: count("REUSE"), resume: count("RESUME_IN_FLIGHT"), generate: count("GENERATE"), regenerate: count("REGENERATE"), reconcile: count("RECONCILE"), humanReview: count("HUMAN_REVIEW"), cancelled: count("SKIP_CANCELLED") }, blocking: decisions.filter((d) => d.action === "RECONCILE").map((d) => d.shotId) };
}
