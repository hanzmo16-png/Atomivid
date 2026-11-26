/** Public Actions logs may expose readiness only; all financial details stay private. */
export function publicStudioReadiness(value: { ready: boolean }): { ready: boolean } {
  return { ready: value.ready === true };
}

/** Public completion proof: expose only whether prior paid work was reused, never counts or money. */
export function publicStudioCompletion(value: { reusedOps: number }): { reused: boolean } {
  return { reused: Number.isFinite(value.reusedOps) && value.reusedOps > 0 };
}
