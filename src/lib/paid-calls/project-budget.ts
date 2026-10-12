/**
 * Cumulative USD cap for ONE project across every run, resume and concurrent worker (hans-01, Codex
 * correction chatgpt-22). Reuses `pi_paid_operations` with no schema change: one "budget hold" row per
 * paid call, keyed `budget:<project>:<seq>`, inserted BEFORE the call is admitted to the paid-call gate.
 *
 * Atomic admission without read-then-act (same technique as capacity-hold.ts): holds of a project form a
 * dense sequence and a run may only insert the next sequence number, so whoever lands seq n saw every
 * hold below n. The admission decision (exposure + next call ≤ cap) is made on that exact view; a lost
 * insert re-lists and retries, bounded.
 *
 * Exposure (conservative, each paid call counted once):
 *  - a non-refunded hold counts max(hold USD, committed USD of the call it covers);
 *  - a paid-operation row not covered by a non-refunded hold counts max(committed, reserved), or its
 *    committed USD once REFUNDED;
 *  - uncertain calls (SUBMITTED / PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED) count at full
 *    reservation and block any call with a different fingerprint until reconciled.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaidOperation, PaidOpStatus } from "@/lib/production-intelligence/ledger";
import { PaidLedgerUnavailableError } from "./errors";

export const BUDGET_HOLD_METHOD = "budget_hold";
const MAX_ROUNDS = 100;
const EPS = 1e-9;

export type BudgetHoldStatus = "RESERVED" | "COMMITTED" | "REFUNDED";
export type BudgetHold = { key: string; seq: number; projectId: string; forKey: string; usd: number; actualUsd: number | null; status: BudgetHoldStatus };
export type ProjectOp = Pick<PaidOperation, "idempotencyKey" | "status" | "reservedUsd" | "committedUsd">;

export interface ProjectBudgetStore {
  listHolds(projectId: string): Promise<BudgetHold[]>;
  /** Paid-operation rows of the project, budget holds excluded. */
  listOps(projectId: string): Promise<ProjectOp[]>;
  /** Insert only if the key is absent; false on conflict. */
  insertHold(row: { key: string; projectId: string; forKey: string; usd: number; createdAt: string }): Promise<boolean>;
  /** Compare-and-set RESERVED → final, recording the USD attributed to the call. */
  settleHold(key: string, status: "COMMITTED" | "REFUNDED", actualUsd: number): Promise<boolean>;
}

export class ProjectBudgetExceededError extends Error {
  constructor(readonly exposureUsd: number, readonly nextUsd: number, readonly capUsd: number) {
    super(`project_budget_exceeded: exposure ${exposureUsd} + next ${nextUsd} > cap ${capUsd}`);
    this.name = "ProjectBudgetExceededError";
  }
}
export class ProjectReservationMismatchError extends Error {
  constructor(readonly forKey: string, readonly coveredUsd: number, readonly requestedUsd: number) {
    super(`project_reservation_mismatch: ${forKey} is covered for ${coveredUsd} but the call now needs ${requestedUsd}; reconcile first`);
    this.name = "ProjectReservationMismatchError";
  }
}
export class ProjectUncertainStateError extends Error {
  constructor(readonly keys: string[]) {
    super(`project_uncertain_state: ${keys.length} paid call(s) await reconciliation; no other call is admitted`);
    this.name = "ProjectUncertainStateError";
  }
}

/** Round UP to the cent: a reservation must never be smaller than the bound it represents. */
export const ceilCents = (usd: number) => Math.ceil(usd * 100 - EPS) / 100;
const cents = (usd: number) => Math.round(usd * 100) / 100;

export const budgetHoldKey = (projectId: string, seq: number) => `budget:${projectId}:${String(seq).padStart(12, "0")}`;
export function parseBudgetSeq(key: string): number | null {
  const m = /^budget:.+:(\d{12})$/.exec(key);
  return m ? Number(m[1]) : null;
}

const UNCERTAIN: PaidOpStatus[] = ["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"];

export function projectExposure(holds: BudgetHold[], ops: ProjectOp[]): { usd: number; uncertainKeys: string[] } {
  const live = holds.filter((h) => h.status !== "REFUNDED");
  const opByKey = new Map(ops.map((o) => [o.idempotencyKey, o]));
  const covered = new Set(live.map((h) => h.forKey));
  let usd = 0;
  for (const h of live) usd += Math.max(h.usd, h.actualUsd ?? 0, opByKey.get(h.forKey)?.committedUsd ?? 0);
  for (const o of ops) {
    if (covered.has(o.idempotencyKey)) continue;
    usd += o.status === "REFUNDED" ? (o.committedUsd ?? 0) : Math.max(o.committedUsd ?? 0, o.reservedUsd);
  }
  const uncertainKeys = ops.filter((o) => UNCERTAIN.includes(o.status)).map((o) => o.idempotencyKey);
  return { usd: cents(usd), uncertainKeys };
}

export type BudgetAdmission = { holdKey: string | null; reused: boolean; exposureUsd: number };

/**
 * Admit one paid call (identified by its paid-call gate key) under the project cap.
 * - The call already has a final or uncertain ledger row → no new hold: replay/resume never pays again and never
 *   resets the total. A row still RESERVED or a hold without a row is only accepted if it already covers the call.
 * - Another call is uncertain → refused (no new fingerprint while something awaits reconciliation).
 * - exposure + usd > cap → refused before any provider call.
 */
export async function admitPaidCall(store: ProjectBudgetStore, a: { projectId: string; forKey: string; usd: number; capUsd: number; now?: () => string }): Promise<BudgetAdmission> {
  const now = a.now ?? (() => new Date().toISOString());
  const usd = ceilCents(a.usd);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const [holds, ops] = await Promise.all([store.listHolds(a.projectId), store.listOps(a.projectId)]);
    const exposure = projectExposure(holds, ops);
    const own = holds.find((h) => h.forKey === a.forKey && h.status !== "REFUNDED");
    const op = ops.find((o) => o.idempotencyKey === a.forKey);
    if (op && op.status !== "RESERVED") {
      // COMMITTED → the gate returns the stored result; REFUNDED → the gate refuses (no rejected retries are
      // allowed by callers of this module); SUBMITTED / PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED → resume
      // the same job or stop for reconciliation. None of them submits a new paid request: nothing new to admit.
      return { holdKey: own?.key ?? null, reused: true, exposureUsd: exposure.usd };
    }
    if (op || own) {
      // RESERVED row (crash before submit) or a hold without a row: the gate WILL submit and pay now. That is only
      // covered by what is already counted; a more expensive call than the earlier reservation is refused.
      const covered = Math.max(op?.reservedUsd ?? 0, own?.usd ?? 0);
      if (usd > covered + EPS) throw new ProjectReservationMismatchError(a.forKey, covered, usd);
      return { holdKey: own?.key ?? null, reused: true, exposureUsd: exposure.usd };
    }
    const others = exposure.uncertainKeys.filter((k) => k !== a.forKey);
    if (others.length) throw new ProjectUncertainStateError(others);
    if (exposure.usd + usd > a.capUsd + EPS) throw new ProjectBudgetExceededError(exposure.usd, usd, a.capUsd);
    const seq = holds.reduce((m, h) => Math.max(m, h.seq + 1), 0);
    const key = budgetHoldKey(a.projectId, seq);
    if (await store.insertHold({ key, projectId: a.projectId, forKey: a.forKey, usd, createdAt: now() })) return { holdKey: key, reused: false, exposureUsd: exposure.usd };
  }
  throw new PaidLedgerUnavailableError("budget hold: too much contention");
}

// ---- stores ----

type Row = { idempotency_key: string; project_id: string; shot_id: string; method: string; status: string; reserved_usd: number | string; committed_usd: number | string | null };
const FOR_PREFIX = "budget-for:";

export function supabaseProjectBudgetStore(supabase: SupabaseClient): ProjectBudgetStore {
  const table = "pi_paid_operations";
  const cols = "idempotency_key,project_id,shot_id,method,status,reserved_usd,committed_usd";
  const list = async (projectId: string) => {
    const { data, error } = await supabase.from(table).select(cols).eq("project_id", projectId);
    if (error) throw new PaidLedgerUnavailableError(`budget list failed (${error.code ?? "?"}): ${error.message}`);
    return (data ?? []) as Row[];
  };
  return {
    async listHolds(projectId) {
      return (await list(projectId)).filter((r) => r.method === BUDGET_HOLD_METHOD).flatMap((r) => {
        const seq = parseBudgetSeq(r.idempotency_key);
        return seq === null ? [] : [{ key: r.idempotency_key, seq, projectId: r.project_id, forKey: r.shot_id.slice(FOR_PREFIX.length), usd: Number(r.reserved_usd),
          actualUsd: r.committed_usd === null ? null : Number(r.committed_usd), status: r.status as BudgetHoldStatus }];
      });
    },
    async listOps(projectId) {
      return (await list(projectId)).filter((r) => r.method !== BUDGET_HOLD_METHOD).map((r) => ({ idempotencyKey: r.idempotency_key, status: r.status as PaidOpStatus,
        reservedUsd: Number(r.reserved_usd), committedUsd: r.committed_usd === null ? null : Number(r.committed_usd) }));
    },
    async insertHold(row) {
      const { error } = await supabase.from(table).insert({
        idempotency_key: row.key, project_id: row.projectId, shot_id: `${FOR_PREFIX}${row.forKey}`, provider: "budget", model: "*", method: BUDGET_HOLD_METHOD,
        attempt_kind: "initial", reserved_usd: row.usd, committed_usd: null, status: "RESERVED", provider_job_id: null, result_ref: null, created_at: row.createdAt, updated_at: row.createdAt,
      });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw new PaidLedgerUnavailableError(`budget insert failed (${error.code ?? "?"}): ${error.message}`);
    },
    async settleHold(key, status, actualUsd) {
      const { data, error } = await supabase.from(table).update({ status, committed_usd: actualUsd, updated_at: new Date().toISOString() })
        .eq("idempotency_key", key).eq("status", "RESERVED").select("idempotency_key");
      if (error) throw new PaidLedgerUnavailableError(`budget settle failed (${error.code ?? "?"}): ${error.message}`);
      return Array.isArray(data) && data.length === 1;
    },
  };
}

/** In-memory store; `ops` is the ledger's map so exposure sees the same rows the paid-call gate writes. */
export function memoryProjectBudgetStore(ops: Map<string, PaidOperation>): ProjectBudgetStore & { holds: Map<string, BudgetHold> } {
  const holds = new Map<string, BudgetHold>();
  return {
    holds,
    async listHolds(projectId) { return [...holds.values()].filter((h) => h.projectId === projectId).map((h) => ({ ...h })); },
    async listOps(projectId) {
      return [...ops.values()].filter((o) => o.projectId === projectId).map((o) => ({ idempotencyKey: o.idempotencyKey, status: o.status, reservedUsd: o.reservedUsd, committedUsd: o.committedUsd }));
    },
    async insertHold(row) {
      if (holds.has(row.key)) return false;
      holds.set(row.key, { key: row.key, seq: parseBudgetSeq(row.key)!, projectId: row.projectId, forKey: row.forKey, usd: row.usd, actualUsd: null, status: "RESERVED" });
      return true;
    },
    async settleHold(key, status, actualUsd) {
      const cur = holds.get(key);
      if (!cur || cur.status !== "RESERVED") return false;
      holds.set(key, { ...cur, status, actualUsd });
      return true;
    },
  };
}
