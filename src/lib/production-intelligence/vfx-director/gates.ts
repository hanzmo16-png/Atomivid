import { z } from "zod";

export const STAGES = ["direction", "styleframe", "motion", "integration", "master"] as const;
export type Stage = typeof STAGES[number];
export const CHECKS: Record<Stage, readonly string[]> = {
  direction: ["story-function", "silent-readability", "world-rules", "lighting-plan", "continuity", "concrete-instructions"],
  styleframe: ["scale-perspective", "lighting", "subject-preservation", "plate-resolution"],
  motion: ["timing-weight", "action-readability", "subject-preservation"],
  integration: ["edges", "occlusion-contact", "lighting", "blur-focus", "continuity"],
  master: ["technical", "caption-clearance", "edit-continuity"],
};
/** Trusted review-service records, never accepted from the planner/model.
 * Evidence proves only that a review was recorded, not that perception is automated. */
export type Approval = { stage: Stage; planHash: string; artifactSha256: string;
  reviewerId: string; approved: boolean; checks: { name: string; pass: boolean; evidence: string }[] };
export type GateContext = { planHash: string; artifacts: Partial<Record<Stage, string>>; approvals: Approval[] };

export function assertGate(stage: Stage, context: GateContext): void {
  const fingerprint = context.artifacts[stage];
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`missing reviewed artifact: ${stage}`);
  const matches = context.approvals.filter(a => a.stage === stage && a.planHash === context.planHash && a.artifactSha256 === fingerprint);
  // A later rejection invalidates an earlier approval of the same version.
  const approval = matches.at(-1);
  if (!approval?.approved || !approval.reviewerId.trim()) throw new Error(`human approval required: ${stage}`);
  if (approval.checks.some(c => !c.pass || !c.evidence.trim()) || CHECKS[stage].some(name => !approval.checks.some(c => c.name === name && c.pass && c.evidence.trim()))) {
    throw new Error(`review evidence failed or incomplete: ${stage}`);
  }
}

export function assertBeforeTask(stage: Stage | "preview", context: GateContext): void {
  if (stage === "preview") return; // Low-cost proof material can precede visual approval.
  const index = STAGES.indexOf(stage);
  for (let i = 0; i < index; i++) assertGate(STAGES[i], context);
}

const nonempty = z.string().trim().min(1);
export const BlockedDirectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NEEDS_MATERIAL"), reason: nonempty, requiredMaterial: z.array(nonempty).min(1) }).strict(),
  z.object({ status: z.literal("REJECTED"), reason: nonempty, alternative: nonempty }).strict(),
]);
