/**
 * Final Cut orchestrator: inspect -> classify -> AUTO_FIX (REPAIR mode only) -> reinspect ->
 * SMART_REPAIR plans (gated, never executed here) -> editorial gate decision -> persist.
 * INSPECT_ONLY: no EDL operation is applied, no plan is executed, the input is untouched
 * (proved by fingerprint). Zero provider calls in every mode.
 */
import { inspect, edlFingerprint } from "./inspect";
import { planAutoFix, applyFixPlan, type FixPlan } from "./auto-fix";
import { proposeRepair, gateRepairs, type RepairPlan } from "./smart-repair";
import { newEditorialRecord, editorialTransition, distributionEligible, finalCutFlags, type EditorialRecord, type EditorialState, type FinalCutFlags } from "./gate";
import { FINAL_CUT_POLICY_V1, type FinalCutPolicy } from "./policy";
import type { FinalCutReport } from "./report";
import type { MasterEdl } from "./edl";
import type { FinalCutStore } from "./persistence";
import type { AdapterRegistry, SpendingCeilings } from "../production-core/admission";
import type { AssetState } from "../production-intelligence/state-machine";

export type FinalCutRun = {
  mode: "INSPECT_ONLY" | "REPAIR";
  initial: FinalCutReport;
  autoFix: { plan: FixPlan; applied: boolean; afterMasterId: string | null; reinspection: FinalCutReport | null };
  repairPlans: RepairPlan[];
  editorial: EditorialRecord;
  finalReport: FinalCutReport;
  distribution: { eligible: boolean; reason: string };
  inputUntouched: boolean;
  networkCalls: number;
};

export async function runFinalCut(e: MasterEdl, o: { mode: "INSPECT_ONLY" | "REPAIR"; now: string; masterState?: AssetState; policy?: FinalCutPolicy; store?: FinalCutStore; flags?: FinalCutFlags; repairGates?: { remainingBudgetUsd: number; adapters: AdapterRegistry; ceilings: SpendingCeilings }; maxRounds?: number }): Promise<FinalCutRun> {
  const before = edlFingerprint(e);
  const frozenInput = JSON.stringify(e);
  let networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("provider/network call forbidden in Final Cut"); }) as typeof fetch;
  try {
    let rec = newEditorialRecord(e.productionId, e.masterId, o.masterState ?? "RENDERED");
    const persist = async (ev: EditorialRecord) => { if (o.store) await o.store.saveDecision(e.productionId, ev.history[ev.history.length - 1]); };
    rec = editorialTransition(rec, "EDITORIAL_INSPECTING", o.now); await persist(rec);
    const initial = inspect(e, { policy: o.policy, mode: o.mode, now: o.now });
    if (o.store) await o.store.saveInspection(initial);
    let current = e, report = initial;
    const plan = planAutoFix(e, initial.issues, o.policy ?? FINAL_CUT_POLICY_V1);
    let applied = false, afterMasterId: string | null = null, reinspection: FinalCutReport | null = null;
    const toState = (r: FinalCutReport): EditorialState => (r.verdict === "PASS" ? "EDITORIAL_QA_PASS" : r.verdict === "REPAIR_REQUIRED" ? "EDITORIAL_REPAIR_REQUIRED" : r.verdict === "FAIL" ? "EDITORIAL_QA_FAIL" : "HUMAN_REVIEW_REQUIRED");
    rec = editorialTransition(rec, toState(initial), o.now, { report: initial }); await persist(rec);
    if (o.mode === "REPAIR" && plan.operations.length && (rec.state === "EDITORIAL_REPAIR_REQUIRED" || rec.state === "EDITORIAL_QA_FAIL")) {
      if (rec.state === "EDITORIAL_QA_FAIL") { rec = editorialTransition(rec, "EDITORIAL_REPAIR_REQUIRED", o.now, { evidence: ["auto-fixable operations exist"] }); await persist(rec); }
      rec = editorialTransition(rec, "EDITORIAL_REPAIRING", o.now, { evidence: plan.operations.map((x) => x.op) }); await persist(rec);
      afterMasterId = `${e.masterId}-fix${rec.rounds}`;
      current = { ...applyFixPlan(e, plan), masterId: afterMasterId };
      applied = true;
      if (o.store) await o.store.saveAutoFix({ masterId: e.masterId, beforeMasterId: e.masterId, afterMasterId, operations: plan.operations, at: o.now, renderRef: null });
      rec = editorialTransition(rec, "EDITORIAL_REINSPECTION", o.now, { masterId: afterMasterId }); await persist(rec);
      rec = editorialTransition(rec, "EDITORIAL_INSPECTING", o.now); await persist(rec);
      reinspection = inspect(current, { policy: o.policy, mode: o.mode, now: o.now });
      if (o.store) await o.store.saveInspection(reinspection);
      report = reinspection;
      rec = editorialTransition(rec, toState(report), o.now, { report }); await persist(rec);
    }
    // SMART_REPAIR: plans for what remains, gated by cost / capacity / policy; never executed here.
    let repairPlans: RepairPlan[] = report.issues.filter((i) => i.repairClass === "SMART_REPAIR").map((i) => proposeRepair(current, i));
    if (o.repairGates && repairPlans.length) repairPlans = await gateRepairs(repairPlans, { ...o.repairGates, now: o.now });
    if (o.store && repairPlans.length) await o.store.saveRepairPlans(repairPlans);
    if (o.store && rec.state === "EDITORIAL_QA_PASS") await o.store.saveMasterMetrics(e.productionId, current.masterId, report.reportId, { technical: report.technical, editorial: report.editorial, opening: report.opening });
    const distribution = distributionEligible(rec, o.flags ?? finalCutFlags());
    return { mode: o.mode, initial, autoFix: { plan, applied, afterMasterId, reinspection }, repairPlans, editorial: rec, finalReport: report, distribution, inputUntouched: edlFingerprint(e) === before && JSON.stringify(e) === frozenInput, networkCalls };
  } finally { globalThis.fetch = realFetch; }
}
