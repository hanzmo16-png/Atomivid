/**
 * YouTube Launch Package: what ATOMIVID PROPOSES; the user approves every item
 * before anything is uploaded. Reuses the existing long-form packaging helpers
 * (src/lib/video/long-form/packaging.ts) for titles/thumbnail paths when present.
 */
import { z } from "zod";

const Candidate = z.object({ text: z.string().min(1), rationale: z.string() });

export const LaunchPackageSchema = z.object({
  projectId: z.string(),
  channelId: z.string(),
  titleCandidates: z.array(Candidate).min(1).max(10),
  thumbnailCandidates: z.array(z.object({ storagePath: z.string(), description: z.string() })).max(6),
  description: z.string().max(5000),
  chapters: z.array(z.object({ startSeconds: z.number().nonnegative(), title: z.string() })),
  keywords: z.array(z.string()).max(30),
  hashtags: z.array(z.string().regex(/^#\w+/)).max(15),
  playlistRecommendation: z.string().nullable(),
  pinnedCommentDraft: z.string().nullable(),
  endScreenRecommendation: z.string().nullable(),
  shortTeaserSuggestions: z.array(z.object({ startSeconds: z.number(), endSeconds: z.number(), hook: z.string() })).max(5),
  approval: z.object({ status: z.enum(["proposed", "approved", "rejected"]), approvedBy: z.string().nullable(), approvedAt: z.string().nullable() }),
});
export type LaunchPackage = z.infer<typeof LaunchPackageSchema>;

/** Claims the system must never make in any proposed text. */
const FORBIDDEN_PROMISES = [/\bviral\b/i, /\bguarantee[sd]?\b/i, /\bmillion views\b/i, /\bgo viral\b/i, /\bCTR\b/, /\bmonetiz/i];

export class LaunchPackageError extends Error {}

export function validateLaunchPackage(p: unknown): LaunchPackage {
  const pkg = LaunchPackageSchema.parse(p);
  const texts = [...pkg.titleCandidates.map((t) => t.text + " " + t.rationale), pkg.description, pkg.pinnedCommentDraft ?? ""];
  for (const t of texts) for (const re of FORBIDDEN_PROMISES) if (re.test(t)) throw new LaunchPackageError(`Package promises outcomes ("${re.source}"); ATOMIVID proposes, it does not promise views/virality/CTR/monetization`);
  // Chapters: YouTube requires the first at 0:00, at least 3, each >= 10 s.
  if (pkg.chapters.length) {
    if (pkg.chapters[0].startSeconds !== 0 || pkg.chapters.length < 3) throw new LaunchPackageError("Chapters must start at 0:00 and contain at least 3 entries");
    for (let i = 1; i < pkg.chapters.length; i++) if (pkg.chapters[i].startSeconds - pkg.chapters[i - 1].startSeconds < 10) throw new LaunchPackageError("Chapters must be at least 10 s apart");
  }
  return pkg;
}
