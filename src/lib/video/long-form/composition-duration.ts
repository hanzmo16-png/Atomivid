import { VIDEO_TAIL_SECONDS } from "../script-pacing";

/** An outro can absorb a small pacing difference, never replace missing narration. */
export const MAX_DURATION_FLOOR_EXTENSION_SECONDS = 2;

export class LongFormCompositionDurationError extends Error {
  constructor(readonly composedSeconds: number, readonly requestedSeconds: number) {
    super(`La composición dura ${composedSeconds.toFixed(2)} s y requiere más de ${MAX_DURATION_FLOOR_EXTENSION_SECONDS} s de cierre para alcanzar ${requestedSeconds} s. No se estira la narración ni se genera material adicional automáticamente.`);
    this.name = "LongFormCompositionDurationError";
  }
}

export function compositionDurationSeconds(narrationSeconds: number, requestedSeconds?: number | null): number {
  if (!Number.isFinite(narrationSeconds) || narrationSeconds <= 0) throw new RangeError("narrationSeconds must be positive and finite");
  const composed = narrationSeconds + VIDEO_TAIL_SECONDS;
  if (requestedSeconds == null) return composed;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) throw new RangeError("requestedSeconds must be positive and finite");
  if (composed >= requestedSeconds) return composed;
  if (requestedSeconds - composed > MAX_DURATION_FLOOR_EXTENSION_SECONDS + 1e-9) {
    throw new LongFormCompositionDurationError(composed, requestedSeconds);
  }
  return requestedSeconds;
}
