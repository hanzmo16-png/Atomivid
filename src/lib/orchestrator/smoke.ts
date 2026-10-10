/**
 * The single smoke call (first real OpenAI call): pure helpers for its one-time guard, its USD 0 preflight and the
 * key's project confirmation.
 *  - Once only, atomically: right before the call the run CREATES the repository label SMOKE_CLAIM_LABEL. GitHub
 *    makes label names unique, so of two concurrent runs exactly one gets 201 and the other 422; any other answer
 *    refuses too (fail closed). The label is never removed automatically: deleting it by hand is Hans's explicit way
 *    to allow another smoke call. Layers on top: a re-run (GITHUB_RUN_ATTEMPT > 1) is refused, the workflow's
 *    concurrency group runs one job at a time, and the whole run history is read (every page) as a second check.
 *  - Preflight: evaluates every gate and the worst-case reservation without sending anything.
 *  - Project: the Responses API answers with openai-project / openai-organization headers; they are logged masked,
 *    so Hans can confirm the key belongs to the project where he set the spend limit.
 */
import { reserve } from "./budget";
import type { OrchestratorConfig } from "./config";
import { emptyState } from "./store";

export const SMOKE_RUN_TITLE = "Orchestrator smoke (paid)";
export const SMOKE_CLAIM_LABEL = "orchestrator-smoke-claimed";

/** The label creation answer: 201 = this run owns the one smoke call; 422 = already claimed; anything else = refuse. */
export const claimOutcome = (status: number): "claimed" | "taken" | "error" => (status === 201 ? "claimed" : status === 422 ? "taken" : "error");

/** A re-run keeps the same run id (the history check would skip it): only the first attempt may send. */
export const firstAttempt = (runAttempt: string | undefined) => (runAttempt ?? "1") === "1";

/** Atomic claim against the GitHub labels API; `post` is injectable for tests. */
export async function claimSmoke(post: (body: string) => Promise<{ status: number }>, runId: string, now = new Date()): Promise<"claimed" | "taken" | "error"> {
  try {
    const res = await post(JSON.stringify({ name: SMOKE_CLAIM_LABEL, color: "b60205", description: `Llamada de humo reclamada por la ejecución ${runId.slice(0, 20)} el ${now.toISOString().slice(0, 16)}Z` }));
    return claimOutcome(res.status);
  } catch { return "error"; }
}

export type RunInfo = { id: number; display_title?: string; status?: string; conclusion?: string | null };

export const smokeAlreadyDone = (runs: RunInfo[], currentRunId: number | null) =>
  runs.some((r) => r.id !== currentRunId && r.display_title === SMOKE_RUN_TITLE && r.conclusion === "success");

export const maskTail = (v: string | null | undefined) => (v ? `…${v.slice(-4)}` : null);

export type KeyIdentity = { project: string | null; organization: string | null; requestId: string | null };
export const identityFromHeaders = (h: Pick<Headers, "get">): KeyIdentity => ({
  project: maskTail(h.get("openai-project")), organization: maskTail(h.get("openai-organization")), requestId: h.get("x-request-id"),
});

/** A call was really sent when the ledger kept it (settled = charged, reserved = outcome unknown); released = nothing charged. */
export const smokeCallSent = (ledger: { state: string }[]) => ledger.some((e) => e.state === "settled" || e.state === "reserved");

export type Preflight = { wouldCall: boolean; blockedReason: string | null; model: string; capUsd: number; worstCaseUsd: number | null; reservationOk: boolean; reservationReason: string | null };

/** USD 0: the gates and the worst-case reservation of the smoke request, without sending it. */
export function smokePreflight(cfg: OrchestratorConfig, inputChars: number): Preflight {
  const r = reserve(emptyState(), cfg, { inputChars, taskId: "preflight", callsThisRun: 0 });
  return {
    wouldCall: cfg.paidCalls && r.ok, blockedReason: cfg.paidBlockedReason, model: cfg.model, capUsd: cfg.budgetCapUsd,
    worstCaseUsd: r.ok ? Math.round(r.reservedUsd * 1e6) / 1e6 : null, reservationOk: r.ok, reservationReason: r.ok ? null : r.reason,
  };
}
