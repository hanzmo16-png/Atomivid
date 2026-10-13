import type { WordTiming } from "@/lib/providers/types";

/** Visual windows cover the whole narration, including its natural pauses.
 * Cut at the next segment's first spoken word; keep the previous visual during
 * the pause. Word timings themselves remain untouched for captions and mixing.
 */
export function alignScenesToWords(
  segments: { text: string }[], words: WordTiming[], narrationDuration: number,
): { start: number; end: number }[] {
  if (!segments.length || !words.length || !Number.isFinite(narrationDuration) || narrationDuration <= 0)
    throw new Error("SCENE_TIMING_INVALID: missing narration timing");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!Number.isFinite(w.startSeconds) || !Number.isFinite(w.endSeconds) || w.startSeconds < 0 ||
        w.endSeconds < w.startSeconds || w.endSeconds > narrationDuration ||
        (i > 0 && w.startSeconds < words[i - 1].startSeconds))
      throw new Error("SCENE_TIMING_INVALID: invalid word timing");
  }
  let wordIndex = 0;
  const starts = segments.map((segment, i) => {
    const count = segment.text.split(/\s+/).filter(Boolean).length;
    if (!count || wordIndex + count > words.length)
      throw new Error("SCENE_TIMING_INVALID: missing segment words");
    const start = i === 0 ? 0 : words[wordIndex].startSeconds;
    wordIndex += count;
    return start;
  });
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? narrationDuration;
    if (!(end > start)) throw new Error("SCENE_TIMING_INVALID: empty visual window");
    return { start, end };
  });
}
