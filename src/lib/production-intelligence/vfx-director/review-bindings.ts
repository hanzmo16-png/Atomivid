import { z } from "zod";
import { jobGates, type Job } from "./jobs";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewBindingSchema = z.object({
  ownerId: z.string(), environmentId: z.string().optional(),
  stage: z.enum(["integration", "master", "preview"]), planHash: hash, artifactSha256: hash,
  assetPath: z.string(), sha256: hash, startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(),
}).strict();
export type ReviewBinding = z.infer<typeof ReviewBindingSchema>;
export function currentReviewBinding(value: unknown, job: Job): ReviewBinding | null {
  const parsed = ReviewBindingSchema.safeParse(value);
  if (!parsed.success) return null;
  const b = parsed.data;
  if (b.ownerId !== job.ownerId || b.startFrame >= b.endFrame || b.endFrame > job.brief.frames
    || !b.assetPath.startsWith(`${job.id}/review/`) || b.assetPath.includes("..") || b.assetPath.includes("\\")
    || !b.assetPath.endsWith(".mp4")) return null;
  if (b.stage === "preview" && b.environmentId) return null;
  if (b.stage === "master" && b.environmentId || b.stage === "integration" && !b.environmentId) return null;
  if (b.environmentId) {
    const e = job.plan.environments.find(e => e.id === b.environmentId);
    if (!e || e.startFrame !== b.startFrame || e.endFrame !== b.endFrame) return null;
  } else if (b.startFrame !== 0 || b.endFrame !== job.brief.frames || b.sha256 !== b.artifactSha256) return null;
  if (b.stage === "preview") return b.planHash === job.planHash && job.plan.tasks.some(t => t.stage === "preview" && job.results[t.id]?.sha256 === b.artifactSha256) ? b : null;
  const gates = jobGates(job, b.environmentId);
  return gates.planHash === b.planHash && gates.artifacts[b.stage] === b.artifactSha256 ? b : null;
}
