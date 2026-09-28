/**
 * Asset lifecycle. QA is not an optional if: executors report, and only this
 * gate decides whether a transition is legal. A failed still has no legal path
 * to motion; a cancelled asset can never create new spend.
 */
export const ASSET_STATES = [
  "PLANNED", "STILL_PENDING", "STILL_READY", "STILL_QA", "STILL_APPROVED", "STILL_FAILED",
  "MOTION_AUTHORIZED", "MOTION_PENDING", "MOTION_QA", "MOTION_FAILED",
  "LOCKED", "RENDERED", "DELIVERED", "CANCELLED",
] as const;
export type AssetState = (typeof ASSET_STATES)[number];

/** States that start a paid provider call. */
export const SPENDING_STATES: readonly AssetState[] = ["STILL_PENDING", "MOTION_PENDING"];

const T: Record<AssetState, AssetState[]> = {
  PLANNED: ["STILL_PENDING", "LOCKED", "CANCELLED"], // LOCKED directly for reused/stock assets
  STILL_PENDING: ["STILL_READY", "STILL_FAILED", "CANCELLED"],
  STILL_READY: ["STILL_QA", "CANCELLED"],
  STILL_QA: ["STILL_APPROVED", "STILL_FAILED"],
  STILL_FAILED: ["STILL_PENDING", "CANCELLED"], // regeneration only, never motion
  STILL_APPROVED: ["MOTION_AUTHORIZED", "LOCKED", "CANCELLED"],
  MOTION_AUTHORIZED: ["MOTION_PENDING", "LOCKED", "CANCELLED"],
  MOTION_PENDING: ["MOTION_QA", "MOTION_FAILED", "CANCELLED"],
  MOTION_QA: ["LOCKED", "MOTION_FAILED"],
  MOTION_FAILED: ["LOCKED", "MOTION_AUTHORIZED", "CANCELLED"], // LOCKED = still-motion fallback; re-authorization needs a new decide()
  LOCKED: ["RENDERED"],
  RENDERED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export type QaReport = { executor: string; pass: boolean; findings: string[] };

export type TransitionEvent = { assetId: string; from: AssetState; to: AssetState; at: string; evidence: string[] };

export class IllegalTransitionError extends Error {}

export type Asset = { assetId: string; state: AssetState; history: TransitionEvent[] };

export function newAsset(assetId: string): Asset {
  return { assetId, state: "PLANNED", history: [] };
}

export function canTransition(from: AssetState, to: AssetState): boolean {
  return T[from].includes(to);
}

/**
 * Apply a transition. QA exits require reports: approval needs every report to pass;
 * a single failing report forces the FAILED branch. MOTION_AUTHORIZED requires a decide() hash.
 */
export function transition(a: Asset, to: AssetState, at: string, opts: { qa?: QaReport[]; decisionHash?: string } = {}): Asset {
  if (!canTransition(a.state, to)) throw new IllegalTransitionError(`${a.assetId}: ${a.state} -> ${to} is not a legal transition`);
  const evidence: string[] = [];
  if (a.state === "STILL_QA" || a.state === "MOTION_QA") {
    const qa = opts.qa ?? [];
    if (!qa.length) throw new IllegalTransitionError(`${a.assetId}: leaving ${a.state} requires QA reports`);
    const pass = qa.every((q) => q.pass);
    const approve = to === "STILL_APPROVED" || to === "LOCKED";
    if (approve && !pass) throw new IllegalTransitionError(`${a.assetId}: QA failed (${qa.filter((q) => !q.pass).map((q) => q.executor).join(", ")}); ${to} is illegal`);
    if (!approve && pass) throw new IllegalTransitionError(`${a.assetId}: all QA passed; ${to} is inconsistent`);
    evidence.push(...qa.map((q) => `${q.executor}:${q.pass ? "PASS" : "FAIL"}${q.findings.length ? " " + q.findings.join("|") : ""}`));
  }
  if (to === "MOTION_AUTHORIZED") {
    if (!opts.decisionHash) throw new IllegalTransitionError(`${a.assetId}: MOTION_AUTHORIZED requires a decide() decisionHash`);
    if (!a.history.some((h) => h.to === "STILL_APPROVED")) throw new IllegalTransitionError(`${a.assetId}: no approved still`);
    evidence.push("decision:" + opts.decisionHash);
  }
  const ev: TransitionEvent = { assetId: a.assetId, from: a.state, to, at, evidence };
  return { assetId: a.assetId, state: to, history: [...a.history, ev] };
}

/** True when entering `to` would start new spend (cancelled assets never can). */
export function wouldSpend(a: Asset, to: AssetState): boolean {
  return canTransition(a.state, to) && SPENDING_STATES.includes(to);
}
