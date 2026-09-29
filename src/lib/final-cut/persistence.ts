/**
 * Auditable persistence of Final Cut: inspections, issues, repairs (proposed + executed),
 * before/after master ids, metrics, QA decisions and human overrides. Memory store for
 * tests; Supabase store (service role) aligned with migration 0027. Provenance-preserving:
 * rows are append-only (a re-inspection is a new inspection row, never an update).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FinalCutReport } from "./report";
import type { RepairPlan } from "./smart-repair";
import type { EdlOperation } from "./auto-fix";
import type { EditorialEvent } from "./gate";

export type ExecutedAutoFix = { masterId: string; beforeMasterId: string; afterMasterId: string; operations: EdlOperation[]; at: string; renderRef: string | null };

export interface FinalCutStore {
  saveInspection(r: FinalCutReport): Promise<void>;
  saveRepairPlans(plans: RepairPlan[]): Promise<void>;
  saveAutoFix(x: ExecutedAutoFix): Promise<void>;
  saveDecision(productionId: string, ev: EditorialEvent): Promise<void>;
  /** Learning-loop row: the editorial metrics of the FINAL master, joinable later with yt_video_links by projectId. */
  saveMasterMetrics(productionId: string, masterId: string, reportId: string, metrics: Record<string, unknown>): Promise<void>;
  inspections(masterId: string): Promise<FinalCutReport[]>;
}

export function memoryFinalCutStore(): FinalCutStore & { reports: FinalCutReport[]; plans: RepairPlan[]; fixes: ExecutedAutoFix[]; decisions: EditorialEvent[]; metrics: { productionId: string; masterId: string; reportId: string; metrics: Record<string, unknown> }[] } {
  const s = {
    reports: [] as FinalCutReport[], plans: [] as RepairPlan[], fixes: [] as ExecutedAutoFix[], decisions: [] as EditorialEvent[], metrics: [] as { productionId: string; masterId: string; reportId: string; metrics: Record<string, unknown> }[],
    async saveInspection(r: FinalCutReport) { if (!s.reports.some((x) => x.reportId === r.reportId)) s.reports.push(r); },
    async saveRepairPlans(p: RepairPlan[]) { for (const x of p) { const i = s.plans.findIndex((y) => y.repairId === x.repairId); if (i >= 0) s.plans[i] = x; else s.plans.push(x); } },
    async saveAutoFix(x: ExecutedAutoFix) { s.fixes.push(x); },
    async saveDecision(_p: string, ev: EditorialEvent) { s.decisions.push(ev); },
    async saveMasterMetrics(productionId: string, masterId: string, reportId: string, metrics: Record<string, unknown>) { s.metrics.push({ productionId, masterId, reportId, metrics }); },
    async inspections(masterId: string) { return s.reports.filter((r) => r.masterId === masterId); },
  };
  return s;
}

const fail = (op: string, e: { message: string } | null) => { if (e) throw new Error(`final-cut store ${op}: ${e.message}`); };

export function supabaseFinalCutStore(sb: SupabaseClient): FinalCutStore {
  return {
    async saveInspection(r) {
      fail("saveInspection", (await sb.from("fc_inspections").upsert({ report_id: r.reportId, master_id: r.masterId, production_id: r.productionId, inspection_version: r.inspectionVersion, policy_version: r.policyVersion, mode: r.mode, source_kind: r.source.kind, source_ref: r.source.ref, input_sha256: r.inputSha256, verdict: r.verdict, technical: r.technical, editorial: r.editorial, opening: r.opening, counts: r.counts, reasons: r.reasons, created_at: r.timestamp }, { ignoreDuplicates: true })).error);
      if (r.issues.length) fail("saveIssues", (await sb.from("fc_issues").upsert(r.issues.map((i) => ({ report_id: r.reportId, issue_id: i.issueId, category: i.category, rule: i.rule, severity: i.severity, confidence: i.confidence, start_time: i.startTime, end_time: i.endTime, shot_id: i.shotId, description: i.description, evidence: i.evidence, recommended_action: i.recommendedAction, repair_class: i.repairClass })), { ignoreDuplicates: true })).error);
    },
    async saveRepairPlans(plans) { if (plans.length) fail("saveRepairPlans", (await sb.from("fc_repairs").upsert(plans.map((p) => ({ repair_id: p.repairId, master_id: p.masterId, issue_id: p.issueId, rule: p.rule, kind: "SMART_REPAIR", proposed_repair: p.proposedRepair, method: p.method, provider_required: p.providerRequired, estimated_usd: p.estimatedIncrementalUsd, worst_case_usd: p.worstCaseUsd, expected_improvement: p.expectedImprovement, fallback: p.fallback, provenance_impact: p.provenanceImpact, gates: p.gates, status: p.status })))).error); },
    async saveAutoFix(x) { fail("saveAutoFix", (await sb.from("fc_repairs").insert({ repair_id: `af_${x.afterMasterId}`, master_id: x.masterId, issue_id: null, rule: "AUTO_FIX", kind: "AUTO_FIX", proposed_repair: "AUTO_FIX", method: null, provider_required: null, estimated_usd: 0, worst_case_usd: 0, expected_improvement: `${x.operations.length} deterministic operations`, fallback: null, provenance_impact: "none", gates: {}, status: "EXECUTED", before_master_id: x.beforeMasterId, after_master_id: x.afterMasterId, operations: x.operations, render_ref: x.renderRef, executed_at: x.at })).error); },
    async saveDecision(productionId, ev) { fail("saveDecision", (await sb.from("fc_qa_decisions").insert({ production_id: productionId, master_id: ev.masterId, from_state: ev.from, to_state: ev.to, report_id: ev.reportId, evidence: ev.evidence, human_override: ev.humanOverride ?? null, decided_at: ev.at })).error); },
    async saveMasterMetrics(productionId, masterId, reportId, metrics) { fail("saveMasterMetrics", (await sb.from("fc_master_metrics").upsert({ production_id: productionId, master_id: masterId, report_id: reportId, metrics })).error); },
    async inspections(masterId) { const { data, error } = await sb.from("fc_inspections").select("*").eq("master_id", masterId); fail("inspections", error); return (data ?? []) as unknown as FinalCutReport[]; },
  };
}
