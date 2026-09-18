/**
 * Initial estimate for the approved narrator, calibrated against actual stored
 * scripts rather than assuming the model met the requested word budget.
 * Word counts are estimates; the measured-duration gate remains authoritative.
 * Reserve the composition's half-second tail in the narration budget.
 */
export const WORDS_PER_SECOND = 2.8;
export const VIDEO_TAIL_SECONDS = 0.5;

export function targetWordsFor(durationSeconds: number): number {
  return Math.max(1, Math.round((durationSeconds - VIDEO_TAIL_SECONDS) * WORDS_PER_SECOND));
}
