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

const NOTE_BASE = "Propuesta del Director sobre un storyboard simulado (sin IA). Semántica y calidad visual: estimado/no validado. ";
const NOTE_PROPOSAL_ONLY = NOTE_BASE + "No cambia el guion ni el render: «Generar video final» sigue siendo el flujo actual.";
// With the render flag on, «Generar video final» re-plans on the REAL footage and that plan drives the render; this panel stays a preview.
const NOTE_RENDER = NOTE_BASE + "No cambia el guion. Al pulsar «Generar video final», el Director vuelve a planificar con el material real y ese plan dirige el montaje; las recetas aplicadas se ven en la página del video.";

/**
 * How the review panel names a shot's movement. This inspection runs BEFORE any material is chosen (simulated
 * storyboard), so `realMotion` only means the plan EXPECTS a clip; it is never presented as verified motion.
 * Zoom/pan without a clip is movement applied over a still image, not motion in the footage.
 */
export function inspectionMotionText(shot: Pick<ReelInspectionShot, "movement" | "realMotion">): string {
  if (shot.realMotion) return "clip con movimiento previsto (material por elegir)";
  if (shot.movement === "push_in_still") return "zoom sobre imagen fija";
  if (shot.movement === "pan") return "paneo sobre imagen fija";
  if (shot.movement === "static") return "imagen fija";
  return shot.movement;
}

/** Counts by kind, so the panel never adds expected clips and still images into one "motion" number. */
export function inspectionMotionSummary(shots: Pick<ReelInspectionShot, "movement" | "realMotion">[]) {
  const expectedClips = shots.filter(s => s.realMotion).length;
  const stillWithMove = shots.filter(s => !s.realMotion && (s.movement === "push_in_still" || s.movement === "pan")).length;
  return { expectedClips, stillWithMove, still: shots.length - expectedClips - stillWithMove };
}

export function inspectReel(script: GeneratedScript, opts: ReelAdapterOptions & { catalog?: RecipeCatalog; renderEnabled?: boolean } = {}): ReelInspection {
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
      issues: audit.issues, metrics: audit.metrics, sequences: report.sequences, note: opts.renderEnabled ? NOTE_RENDER : NOTE_PROPOSAL_ONLY,
    };
  } catch (err) {
    // Inspection must never break the review page: an error is shown as such, generation is unaffected.
    return { status: "error", mode: "proposal", executable: false, paidCalls: 0, message: err instanceof Error ? err.message.slice(0, 300) : "error desconocido" };
  }
}
