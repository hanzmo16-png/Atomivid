/**
 * What the documentary script worker (scripts/documentary-script-worker.ts) does after one step answer. Pure, so the
 * long-wait handling is tested without a network: «waiting_period» (daily quota / period spend ceiling) stops at
 * once; «waiting» (a short supply wait) retries after 15 s within the worker's bounded wall clock.
 */
export type WorkerAction = { kind: "done" } | { kind: "stop_waiting_period" } | { kind: "retry"; afterMs: number } | { kind: "error"; message: string };
export function workerNextAction(state: string): WorkerAction {
  if (state === "completed" || state === "probe_ok") return { kind: "done" };
  if (state === "waiting_period") return { kind: "stop_waiting_period" };
  if (state === "running") return { kind: "retry", afterMs: 60_000 }; // owned by another invocation: wait, never steal
  if (state === "waiting") return { kind: "retry", afterMs: 15_000 };
  if (state === "queued") return { kind: "retry", afterMs: 0 };
  return { kind: "error", message: `Preparation stopped: ${state}` };
}
