/**
 * Persistent logical-intent identity for the full Reel script generation (POST /api/generate/[id]/script).
 *
 * Before this module every POST ran under `intentId: randomUUID()`, so a retry or a double click after a provider
 * call with an uncertain outcome got a NEW ledger key: the RECONCILIATION_REQUIRED row of the first attempt never
 * blocked the second call, the second reservation or the second invoice (incident 1561fdb2, 2026-10-11).
 *
 * Now the intent is derived from the ledger itself, per video request:
 *  - any uncertain row (RECONCILIATION_REQUIRED, PROVIDER_JOB_RECORDED, a stale SUBMITTED) → no new call at all
 *    until an operator reconciles it with the provider;
 *  - a fresh RESERVED/SUBMITTED row → another generation is in flight (double click) → no new call;
 *  - otherwise `gen-N`, N = 1 + the highest generation already settled (COMMITTED/REFUNDED). The same request
 *    replayed gets the same N, hence the same idempotency key; an explicit regeneration after a settled one
 *    (legitimate new intent) gets N+1 and still goes through the ledger and its caps.
 * Pure apart from the injected ledger store (tests use memoryLedgerStore).
 */
import type { LedgerStore, PaidOperation, PaidOpStatus } from "@/lib/production-intelligence/ledger";

export type ScriptOpRow = { status: PaidOpStatus; shot_id: string; updated_at: string; idempotency_key?: string };
export type ScriptIntentBlock = "in_flight" | "requires_reconciliation";

/** A submission older than this cannot still be running inside a 60 s route (maxDuration). */
export const SCRIPT_IN_FLIGHT_STALE_MS = 120_000;
const GEN_PREFIX = /^script:gen-(\d+):/;

export class ScriptReconciliationRequiredError extends Error {
  override name = "ScriptReconciliationRequiredError";
  constructor(readonly state: ScriptIntentBlock, detail: string) { super(`script generation blocked (${state}): ${detail}`); }
}

/** The ledger could not be read BEFORE any call: nothing was reserved or sent, the customer may try later. */
export class ScriptLedgerUnavailableError extends Error { override name = "ScriptLedgerUnavailableError"; }

export function decideScriptIntent(rows: readonly ScriptOpRow[], nowMs: number, staleMs = SCRIPT_IN_FLIGHT_STALE_MS): { intentId: string } {
  let next = 0;
  for (const r of rows) {
    if (r.status === "RECONCILIATION_REQUIRED" || r.status === "PROVIDER_JOB_RECORDED") throw new ScriptReconciliationRequiredError("requires_reconciliation", `a previous call is ${r.status}`);
    if (r.status === "RESERVED" || r.status === "SUBMITTED") {
      const age = nowMs - Date.parse(r.updated_at);
      // A RESERVED row never reached the provider, but a stale SUBMITTED one may have: only the former is harmless.
      if (r.status === "SUBMITTED" && !(age < staleMs)) throw new ScriptReconciliationRequiredError("requires_reconciliation", "a previous submission never confirmed its outcome");
      if (age < staleMs) throw new ScriptReconciliationRequiredError("in_flight", "another generation is running");
      continue;
    }
    const m = GEN_PREFIX.exec(r.shot_id);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  return { intentId: `gen-${next}` };
}

/**
 * Claims the ledger row of one guarded call before the engine runs. executePaidOperation turns a SUBMITTED row it
 * did not write into RECONCILIATION_REQUIRED (correct after a crash, wrong for a concurrent duplicate of the same
 * key, which would also lose the first call's result). The insert is unique, so of two concurrent requests with the
 * same key exactly one owns the row; the other stops here without touching it.
 * Resolves when the engine may proceed (own fresh row, settled row to reuse, or a stale RESERVED never submitted);
 * throws ScriptReconciliationRequiredError otherwise.
 */
export async function claimScriptOperation(store: Pick<LedgerStore, "get" | "insert">, op: Omit<PaidOperation, "status" | "providerJobId" | "resultRef" | "committedUsd" | "updatedAt">, nowMs: number, staleMs = SCRIPT_IN_FLIGHT_STALE_MS): Promise<void> {
  const fresh: PaidOperation = { ...op, status: "RESERVED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: new Date(nowMs).toISOString() };
  if (await store.insert(fresh)) return;
  const cur = await store.get(op.idempotencyKey);
  if (!cur) throw new ScriptReconciliationRequiredError("requires_reconciliation", "ledger row vanished");
  if (cur.status === "COMMITTED" || cur.status === "REFUNDED") return;
  decideScriptIntent([{ status: cur.status, shot_id: cur.shotId, updated_at: cur.updatedAt }], nowMs, staleMs);
}

/** resultRef of a reservation released because it never reached the provider (not a refund of a real call). */
export const RELEASED_STALE_REF = "released:stale-reserved-never-submitted";

/**
 * A RESERVED row older than the in-flight window never reached the provider (the engine moves it to SUBMITTED,
 * atomically, BEFORE calling) and no live request can still own it. Left alone it would stay reserved forever (an
 * orphan counted against caps) whenever the next attempt has a different key, e.g. after an edited topic. It is
 * released with a compare-and-set RESERVED → REFUNDED (committedUsd 0, RELEASED_STALE_REF), so the next generation
 * gets gen-N+1 and exactly one live reservation. If the CAS loses (someone submitted it meanwhile) the row's real
 * status is used instead, so a submission is never mistaken for a released reservation.
 */
export async function releaseStaleReservations(store: Pick<LedgerStore, "get" | "update">, rows: readonly ScriptOpRow[], nowMs: number, staleMs = SCRIPT_IN_FLIGHT_STALE_MS): Promise<ScriptOpRow[]> {
  const out: ScriptOpRow[] = [];
  for (const r of rows) {
    if (r.status !== "RESERVED" || !r.idempotency_key || nowMs - Date.parse(r.updated_at) < staleMs) { out.push(r); continue; }
    const updated_at = new Date(nowMs).toISOString();
    if (await store.update(r.idempotency_key, "RESERVED", { status: "REFUNDED", committedUsd: 0, resultRef: RELEASED_STALE_REF, updatedAt: updated_at })) {
      out.push({ ...r, status: "REFUNDED", updated_at });
      continue;
    }
    const cur = await store.get(r.idempotency_key);
    out.push(cur ? { ...r, status: cur.status, updated_at: cur.updatedAt } : r);
  }
  return out;
}

/** After a failed generation: is a call of this request now uncertain or still running? null = settled. */
export function scriptBlockState(rows: readonly ScriptOpRow[], nowMs: number, staleMs = SCRIPT_IN_FLIGHT_STALE_MS): ScriptIntentBlock | null {
  try { decideScriptIntent(rows, nowMs, staleMs); return null; } catch (e) { if (e instanceof ScriptReconciliationRequiredError) return e.state; throw e; }
}
