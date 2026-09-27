/** Short, stable text above the subtitle band, timed relative to its scene. */
export type SceneOverlay = {
  text: string;
  source?: string;
  startSeconds?: number;
  endSeconds?: number;
};

export function overlayIssue(overlay: SceneOverlay, duration: number): string | undefined {
  if (!overlay.text.trim() || overlay.text.length > 72 || /[\r\n]/.test(overlay.text)) return "overlay text must be 1–72 characters on one line";
  if ((overlay.source?.length ?? 0) > 100) return "overlay source exceeds 100 characters";
  const start = overlay.startSeconds ?? 0;
  const end = overlay.endSeconds ?? duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.05) return "overlay timing outside scene";
}
