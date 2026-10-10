/**
 * The single smoke call (first real OpenAI call): pure helpers for its one-time guard, its USD 0 preflight and the
 * key's project confirmation.
 *  - Once only: the smoke run has no durable store, so its guard is the repository's own run history. A run titled
 *    SMOKE_RUN_TITLE ends "success" only when a call was really sent (charged or uncertain); a later smoke run sees
 *    it and refuses. A run that sent nothing ends "failure" and does not count.
 *  - Preflight: evaluates every gate and the worst-case reservation without sending anything.
 *  - Project: the Responses API answers with openai-project / openai-organization headers; they are logged masked,
 *    so Hans can confirm the key belongs to the project where he set the spend limit.
 */
import { reserve } from "./budget";
import type { OrchestratorConfig } from "./config";
import { emptyState } from "./store";

export const SMOKE_RUN_TITLE = "Orchestrator smoke (paid)";

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
