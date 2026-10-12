/**
 * Read-only Director inspection of a Reel BEFORE generation (chatgpt-23). Pure and deterministic:
 * saved script -> simulateStoryboard (no provider call) -> Reel adapter -> proposePlan -> auditPlan -> report.
 * It never writes the request, never changes the script, never decides whether the user may generate, and has no
 * provider, ledger or network dependency: contract mode "proposal", executable=false, paidCalls=0.
 * Execution stays in the existing render pipeline, behind its own permissions and budget.
 */
import type { GeneratedScript } from "@/lib/providers/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import { DirectorInputSchema, type DirectorPlan } from "./contract";
import { auditPlan, type AuditMetrics, type Issue } from "./audit";
import { inputFromReel, type ReelAdapterOptions } from "./from-reel";
import { proposePlan } from "./propose";
import { bundledRecipeCatalog } from "./recipes";
import { editorialReport } from "./report";
import type { RecipeCatalog } from "./contract";

export type ReelInspectionShot = {
  id: string; segmentId: string; start: number; end: number; anchorText: string; recipeId: string | null;
  movement: string; realMotion: boolean; assetStatus: string; label: string | null; decision: string; pendingReason?: string;
};
export type ReelInspection =
  | { status: "ok" | "issues"; mode: "proposal"; executable: false; paidCalls: 0; storyboardSource: "simulated";
      totalSeconds: number; shots: ReelInspectionShot[]; issues: Issue[]; metrics: AuditMetrics | null;
      sequences: ReturnType<typeof editorialReport>["sequences"]; note: string }
  | { status: "error"; mode: "proposal"; executable: false; paidCalls: 0; message: string };

const NOTE = "Propuesta del Director sobre un storyboard simulado (sin IA). Semántica y calidad visual: estimado/no validado. " +
  "No cambia el guion ni el render: «Generar video final» sigue siendo el flujo actual.";

export function inspectReel(script: GeneratedScript, opts: ReelAdapterOptions & { catalog?: RecipeCatalog } = {}): ReelInspection {
  try {
    if (!script?.segments?.length) return { status: "error", mode: "proposal", executable: false, paidCalls: 0, message: "El guion no tiene segmentos." };
    const catalog = opts.catalog ?? bundledRecipeCatalog();
    const raw = inputFromReel(simulateStoryboard(script), opts);
    const plan: DirectorPlan = proposePlan(raw, catalog);
    const audit = auditPlan(plan, raw, catalog);
    const report = editorialReport(plan, DirectorInputSchema.parse(raw));
    return {
      status: audit.ok ? "ok" : "issues", mode: "proposal", executable: false, paidCalls: 0, storyboardSource: "simulated",
      totalSeconds: plan.totalSeconds,
      shots: plan.shots.map(s => ({ id: s.id, segmentId: s.segmentId, start: s.start, end: s.end, anchorText: s.anchorText, recipeId: s.recipeId,
        movement: s.movement.kind, realMotion: s.movement.realMotion, assetStatus: s.asset.status, label: s.asset.label,
        decision: s.decision.status, pendingReason: s.decision.pendingReason })),
      issues: audit.issues, metrics: audit.metrics, sequences: report.sequences, note: NOTE,
    };
  } catch (err) {
    // Inspection must never break the review page: an error is shown as such, generation is unaffected.
    return { status: "error", mode: "proposal", executable: false, paidCalls: 0, message: err instanceof Error ? err.message.slice(0, 300) : "error desconocido" };
  }
}
