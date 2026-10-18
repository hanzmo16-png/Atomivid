/**
 * Reads the Director record stored next to a rendered Reel (`<attempt dir>/director.json`, written by
 * generate-video.ts only when CINEMATIC_DIRECTOR_RENDER_ENABLED was on) so the video page can show which recipe
 * was applied to each shot. Read-only; a missing or malformed record simply shows nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type AppliedShotRow = {
  shotId: string; anchorText: string; recipeId: string | null; startSeconds: number; endSeconds: number;
  plannedMovement: string; motion: string; transitionIn: string; transitionOut: string; label: string | null; unsupported: string[];
};

export function directorRecordPath(videoPath: string): string {
  const i = videoPath.lastIndexOf("/");
  return `${i >= 0 ? videoPath.slice(0, i) : ""}/director.json`.replace(/^\//, "");
}

/**
 * Rows for the video page, or null when the record cannot prove what was applied to THIS video (T-34 B3): it must be
 * ok, belong to the same attempt as the MP4 (`artifactPrefix` = MP4 folder), carry the real duration, and every shot
 * must have a unique id and a finite interval inside the video, in order and without overlaps.
 */
export function parseDirectorRecord(raw: unknown, videoPath?: string): AppliedShotRow[] | null {
  const r = raw as { ok?: unknown; applied?: unknown; artifactPrefix?: unknown; durationSeconds?: unknown };
  if (!r || r.ok !== true || !Array.isArray(r.applied) || r.applied.length === 0) return null;
  if (videoPath !== undefined) {
    const folder = videoPath.slice(0, Math.max(0, videoPath.lastIndexOf("/")));
    if (typeof r.artifactPrefix !== "string" || r.artifactPrefix !== folder) return null;
    if (typeof r.durationSeconds !== "number" || !Number.isFinite(r.durationSeconds) || r.durationSeconds <= 0) return null;
  }
  const limit = typeof r.durationSeconds === "number" ? r.durationSeconds + 0.05 : Number.POSITIVE_INFINITY;
  const rows: AppliedShotRow[] = [];
  const seen = new Set<string>();
  let lastEnd = 0;
  for (const a of r.applied as Record<string, unknown>[]) {
    const ap = a?.applied as Record<string, unknown> | undefined, pl = a?.planned as Record<string, unknown> | undefined;
    if (!ap || !pl || typeof a.shotId !== "string" || typeof ap.startSeconds !== "number" || typeof ap.endSeconds !== "number") return null;
    const { startSeconds, endSeconds } = ap as { startSeconds: number; endSeconds: number };
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds
      || endSeconds > limit || startSeconds < lastEnd - 0.05 || seen.has(a.shotId)) return null;
    seen.add(a.shotId);
    lastEnd = endSeconds;
    rows.push({ shotId: a.shotId, anchorText: String(a.anchorText ?? ""), recipeId: typeof a.recipeId === "string" ? a.recipeId : null,
      startSeconds, endSeconds, plannedMovement: String(pl.movement ?? ""), motion: String(ap.motion ?? ""),
      transitionIn: String(ap.transitionIn ?? ""), transitionOut: String(ap.transitionOut ?? ""), label: typeof ap.label === "string" ? ap.label : null,
      unsupported: Array.isArray(a.unsupported) ? (a.unsupported as unknown[]).map(String) : [] });
  }
  return rows;
}

export async function loadDirectorApplied(service: SupabaseClient, videoPath: string): Promise<AppliedShotRow[] | null> {
  try {
    const { data, error } = await service.storage.from("videos").download(directorRecordPath(videoPath));
    if (error || !data) return null;
    return parseDirectorRecord(JSON.parse(await data.text()), videoPath);
  } catch {
    return null;
  }
}

/**
 * Whether the web requested the Director for this request's attempt (T-34 B3). Separate, best-effort read so the video
 * page never breaks on it: any error counts as "not requested" and simply hides the notice.
 */
export async function loadDirectorRequested(supabase: SupabaseClient, requestId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("video_requests").select("director_requested").eq("id", requestId).maybeSingle<{ director_requested: boolean | null }>();
    return !error && data?.director_requested === true;
  } catch {
    return false;
  }
}
