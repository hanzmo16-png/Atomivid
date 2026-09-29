/**
 * Editorial Quality Gate: an explicit state machine that sits AFTER the PI asset lifecycle
 * (a master must be RENDERED) and BEFORE distribution. Composed, not merged: the PI
 * state-machine.ts is untouched. Distribution treats a master as FINAL only with
 * EDITORIAL_QA_PASS when Final Cut is enabled.
 */
import type { AssetState } from "../production-intelligence/state-machine";
import type { FinalCutReport } from "./report";

export const EDITORIAL_STATES = ["EDITORIAL_PENDING", "EDITORIAL_INSPECTING", "EDITORIAL_REPAIR_REQUIRED", "EDITORIAL_REPAIRING", "EDITORIAL_REINSPECTION", "EDITORIAL_QA_PASS", "EDITORIAL_QA_FAIL", "HUMAN_REVIEW_REQUIRED"] as const;
export type EditorialState = (typeof EDITORIAL_STATES)[number];

const T: Record<EditorialState, EditorialState[]> = {
  EDITORIAL_PENDING: ["EDITORIAL_INSPECTING"],
  EDITORIAL_INSPECTING: ["EDITORIAL_QA_PASS", "EDITORIAL_REPAIR_REQUIRED", "EDITORIAL_QA_FAIL", "HUMAN_REVIEW_REQUIRED"],
  EDITORIAL_REPAIR_REQUIRED: ["EDITORIAL_REPAIRING", "HUMAN_REVIEW_REQUIRED"],
  EDITORIAL_REPAIRING: ["EDITORIAL_REINSPECTION", "HUMAN_REVIEW_REQUIRED"],
  EDITORIAL_REINSPECTION: ["EDITORIAL_INSPECTING"],
  EDITORIAL_QA_PASS: [],
  EDITORIAL_QA_FAIL: ["EDITORIAL_REPAIR_REQUIRED", "HUMAN_REVIEW_REQUIRED"],
  HUMAN_REVIEW_REQUIRED: ["EDITORIAL_QA_PASS", "EDITORIAL_QA_FAIL", "EDITORIAL_REPAIR_REQUIRED"], // only with a recorded human decision
};

export class IllegalEditorialTransitionError extends Error {}

export type EditorialEvent = { from: EditorialState; to: EditorialState; at: string; reportId: string | null; masterId: string; evidence: string[]; humanOverride?: { by: string; decision: string; reason: string } };
export type EditorialRecord = { productionId: string; masterId: string; state: EditorialState; rounds: number; history: EditorialEvent[] };

export function newEditorialRecord(productionId: string, masterId: string, masterState: AssetState): EditorialRecord {
  if (masterState !== "RENDERED" && masterState !== "DELIVERED") throw new IllegalEditorialTransitionError(`master ${masterId} is ${masterState}: editorial QA needs a RENDERED master`);
  return { productionId, masterId, state: "EDITORIAL_PENDING", rounds: 0, history: [] };
}

export function editorialTransition(r: EditorialRecord, to: EditorialState, at: string, o: { report?: FinalCutReport | null; masterId?: string; evidence?: string[]; humanOverride?: EditorialEvent["humanOverride"] } = {}): EditorialRecord {
  if (!T[r.state].includes(to)) throw new IllegalEditorialTransitionError(`${r.masterId}: ${r.state} -> ${to} is not a legal editorial transition`);
  const evidence = [...(o.evidence ?? [])];
  if (r.state === "EDITORIAL_INSPECTING") {
    if (!o.report) throw new IllegalEditorialTransitionError("leaving EDITORIAL_INSPECTING requires the inspection report");
    const expected: Record<FinalCutReport["verdict"], EditorialState> = { PASS: "EDITORIAL_QA_PASS", REPAIR_REQUIRED: "EDITORIAL_REPAIR_REQUIRED", FAIL: "EDITORIAL_QA_FAIL", HUMAN_REVIEW_REQUIRED: "HUMAN_REVIEW_REQUIRED" };
    if (expected[o.report.verdict] !== to) throw new IllegalEditorialTransitionError(`report verdict ${o.report.verdict} does not allow ${to}`);
    if (o.report.masterId !== (o.masterId ?? r.masterId)) throw new IllegalEditorialTransitionError("report belongs to another master");
    evidence.push(`report:${o.report.reportId}`, `verdict:${o.report.verdict}`, `input:${o.report.inputSha256.slice(0, 16)}`);
  }
  if (r.state === "HUMAN_REVIEW_REQUIRED") {
    if (!o.humanOverride) throw new IllegalEditorialTransitionError("leaving HUMAN_REVIEW_REQUIRED requires a recorded human decision");
    evidence.push(`human:${o.humanOverride.by}:${o.humanOverride.decision}`);
  }
  if (to === "EDITORIAL_REINSPECTION" && !o.masterId) throw new IllegalEditorialTransitionError("reinspection needs the id of the repaired master");
  const masterId = o.masterId ?? r.masterId;
  const ev: EditorialEvent = { from: r.state, to, at, reportId: o.report?.reportId ?? null, masterId, evidence, ...(o.humanOverride ? { humanOverride: o.humanOverride } : {}) };
  return { ...r, masterId, state: to, rounds: to === "EDITORIAL_INSPECTING" ? r.rounds + 1 : r.rounds, history: [...r.history, ev] };
}

export type FinalCutFlags = { enabled: boolean };
export const finalCutFlags = (env: Record<string, string | undefined> = process.env): FinalCutFlags => ({ enabled: env.FINAL_CUT_ENABLED !== "false" });

/** Distribution / YouTube linkage may only consider a master FINAL when editorial QA passed (or Final Cut is explicitly disabled). */
export function distributionEligible(r: EditorialRecord | null, flags: FinalCutFlags): { eligible: boolean; reason: string } {
  if (!flags.enabled) return { eligible: true, reason: "Final Cut disabled by FINAL_CUT_ENABLED=false" };
  if (!r) return { eligible: false, reason: "no editorial record: the master was never inspected" };
  if (r.state !== "EDITORIAL_QA_PASS") return { eligible: false, reason: `editorial state ${r.state} != EDITORIAL_QA_PASS` };
  return { eligible: true, reason: `EDITORIAL_QA_PASS on ${r.masterId}` };
}
