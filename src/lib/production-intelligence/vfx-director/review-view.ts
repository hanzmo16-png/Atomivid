import { assertBeforeTask, assertGate, CHECKS, STAGES, type Stage } from "./gates";
import { jobGates, type Job } from "./jobs";

export const STAGE_LABELS: Record<Stage, string> = {
  direction: "Dirección", styleframe: "Frame ley", motion: "Movimiento",
  integration: "Integración", master: "Composición final",
};
export function reviewView(job: Job, environmentId?: string) {
  const scope = jobGates(job, environmentId);
  return (environmentId ? STAGES.slice(0, -1) : ["master"] as const).map(stage => {
    const sha256 = scope.artifacts[stage];
    const review = scope.approvals.filter(a => a.stage === stage && a.planHash === scope.planHash && a.artifactSha256 === sha256).at(-1);
    let approved = false;
    let prerequisitesMet = false;
    try { assertGate(stage, scope); approved = true; } catch { /* Pending/rejected is displayed explicitly. */ }
    try { assertBeforeTask(stage, scope); prerequisitesMet = true; } catch { /* A defect prevents advancing. */ }
    return { stage, label: STAGE_LABELS[stage], sha256, planHash: scope.planHash,
      state: approved ? "approved" : review && !review.approved ? "rejected" : sha256 ? "review" : "missing",
      canApprove: Boolean(sha256 && prerequisitesMet && job.status !== "RUNNING"),
      canReject: Boolean(sha256 && job.status !== "RUNNING"), checks: [...CHECKS[stage]],
      evidence: review?.checks ?? [] };
  });
}
export type ReviewStage = ReturnType<typeof reviewView>[number];
