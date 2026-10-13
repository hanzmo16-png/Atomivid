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

export function parseDirectorRecord(raw: unknown): AppliedShotRow[] | null {
  const r = raw as { ok?: unknown; applied?: unknown };
  if (!r || r.ok !== true || !Array.isArray(r.applied)) return null;
  const rows: AppliedShotRow[] = [];
  for (const a of r.applied as Record<string, unknown>[]) {
    const ap = a?.applied as Record<string, unknown> | undefined, pl = a?.planned as Record<string, unknown> | undefined;
    if (!ap || !pl || typeof a.shotId !== "string" || typeof ap.startSeconds !== "number" || typeof ap.endSeconds !== "number") return null;
    rows.push({ shotId: a.shotId, anchorText: String(a.anchorText ?? ""), recipeId: typeof a.recipeId === "string" ? a.recipeId : null,
      startSeconds: ap.startSeconds, endSeconds: ap.endSeconds, plannedMovement: String(pl.movement ?? ""), motion: String(ap.motion ?? ""),
      transitionIn: String(ap.transitionIn ?? ""), transitionOut: String(ap.transitionOut ?? ""), label: typeof ap.label === "string" ? ap.label : null,
      unsupported: Array.isArray(a.unsupported) ? (a.unsupported as unknown[]).map(String) : [] });
  }
  return rows;
}

export async function loadDirectorApplied(service: SupabaseClient, videoPath: string): Promise<AppliedShotRow[] | null> {
  try {
    const { data, error } = await service.storage.from("videos").download(directorRecordPath(videoPath));
    if (error || !data) return null;
    return parseDirectorRecord(JSON.parse(await data.text()));
  } catch {
    return null;
  }
}
