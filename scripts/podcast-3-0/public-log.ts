/** Public Actions logs may expose readiness only; all financial details stay private. */
export function publicStudioReadiness(value: { ready: boolean }): { ready: boolean } {
  return { ready: value.ready === true };
}
