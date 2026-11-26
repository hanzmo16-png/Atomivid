import { VIDEO_TAIL_SECONDS } from "../script-pacing";

/** An outro can absorb a small pacing difference, never replace missing narration. */
export const MAX_DURATION_FLOOR_EXTENSION_SECONDS = 2;

export function compositionDurationSeconds(narrationSeconds: number, requestedSeconds?: number | null): number {
  if (!Number.isFinite(narrationSeconds) || narrationSeconds <= 0) throw new RangeError("narrationSeconds must be positive and finite");
  const composed = narrationSeconds + VIDEO_TAIL_SECONDS;
  if (requestedSeconds == null) return composed;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) throw new RangeError("requestedSeconds must be positive and finite");
  if (composed >= requestedSeconds) return composed;
  if (requestedSeconds - composed > MAX_DURATION_FLOOR_EXTENSION_SECONDS + 1e-9) {
    // Preserve the established narration-duration tolerance; never manufacture a long silent outro.
    return composed;
  }
  return requestedSeconds;
}
