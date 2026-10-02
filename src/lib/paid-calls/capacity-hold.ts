/**
 * Atomic provider-capacity hold before a Generate job may reach the paid-call gate (PI V2 Fase
 * B2, RB-02). Reuses `pi_paid_operations` (migration 0023): one row per hold.
 *
 * Atomicity without a read-then-act: holds for a provider form a dense sequence. A job lists the
 * holds, computes the next sequence number and tries to INSERT exactly that primary key. The
 * table's primary key serialises the inserts: whoever lands `cap:<provider>:<n>` is the only one
 * who saw every hold below n (any hold j < n inserted after the listing would have made that job
 * target j, not n). The admission decision (demand ≤ balance − open holds) is therefore made on
 * an exact view of all prior holds; a lost insert (23505) re-lists and retries, bounded.
 *
 * Open holds: RESERVED, plus COMMITTED holds created after the balance snapshot (the provider's
 * balance cannot reflect them yet). REFUNDED never counts. UNKNOWN balance or a port error → no
 * hold, no job. Units live in `result_ref` ("units:<n>"); `reserved_usd` is the USD estimate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PaidLedgerUnavailableError } from "./errors";
import type { ProviderBalancePort } from "./capacity-port";

export const CAPACITY_HOLD_METHOD = "capacity_hold";
const KEY_PREFIX = "cap:";
const MAX_ACQUIRE_ROUNDS = 100;

export type CapacityHoldStatus = "RESERVED" | "COMMITTED" | "REFUNDED";
export type CapacityHoldRow = { key: string; seq: number; provider: string; projectId: string; status: CapacityHoldStatus; units: number; createdAt: string };
export type CapacityDemand = { provider: string; units: number; usd: number };
export type AcquiredHold = { key: string; provider: string; units: number };

export interface CapacityHoldStore {
  listHolds(provider: string): Promise<CapacityHoldRow[]>;
  /** Insert only if the key is absent; false on conflict. */
  insertHold(row: { key: string; provider: string; projectId: string; units: number; usd: number; createdAt: string }): Promise<boolean>;
  /** Compare-and-set RESERVED → final. */
  settleHold(key: string, status: "COMMITTED" | "REFUNDED"): Promise<boolean>;
  /** Open holds of one request (previous attempts of the same job). */
  listOpenHoldsForProject(projectId: string): Promise<CapacityHoldRow[]>;
}

export class CapacityUnavailableError extends Error {
  readonly customerMessage: string;
  /** Lets run-job.ts (isCustomerSafeError) show the safe text and keep `detail` for the diagnostic log. */
  readonly diagnosticId: string;
  constructor(readonly provider: string, readonly detail: string) {
    super(`No se pudo confirmar capacidad disponible del proveedor (${provider}): ${detail}. No se inició ninguna generación pagada.`);
    this.name = "CapacityUnavailableError";
    this.customerMessage = "No se pudo confirmar la capacidad del proveedor para esta solicitud. No se inició ninguna generación pagada; vuelve a intentarlo más tarde.";
    this.diagnosticId = `CAP-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  }
}

export const holdKey = (provider: string, seq: number) => `${KEY_PREFIX}${provider}:${String(seq).padStart(12, "0")}`;
export function parseHoldSeq(key: string): number | null {
  const m = /^cap:[^:]+:(\d{1,12})$/.exec(key);
  return m ? Number(m[1]) : null;
}
export const unitsFromRef = (ref: string | null | undefined) => {
  const m = /^units:(\d+(?:\.\d+)?)$/.exec(ref ?? "");
  return m ? Number(m[1]) : 0;
};

export type AcquireResult = { acquired: true; holds: AcquiredHold[] } | { acquired: false; provider: string; reason: string };

/**
 * Acquire one hold per demand, all or nothing. Rejection never throws for a capacity decision;
 * a port or store failure is also a rejection (fail closed), reported in `reason`.
 */
export async function acquireCapacityHolds(
  deps: { store: CapacityHoldStore; balance: ProviderBalancePort; now?: () => string },
  input: { requestId: string; demands: CapacityDemand[] },
): Promise<AcquireResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const acquired: AcquiredHold[] = [];
  const rollback = async () => {
    for (const h of acquired) await deps.store.settleHold(h.key, "REFUNDED").catch(() => false);
  };
  for (const demand of input.demands) {
    if (!(demand.units > 0)) continue;
    let balance;
    try {
      balance = await deps.balance.read(demand.provider);
    } catch (err) {
      await rollback();
      return { acquired: false, provider: demand.provider, reason: `balance read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!balance.known) {
      await rollback();
      return { acquired: false, provider: demand.provider, reason: `balance UNKNOWN (${balance.reason})` };
    }
    const snapshotAt = Date.parse(balance.checkedAt);
    let outcome: AcquiredHold | string | null = null;
    for (let round = 0; round < MAX_ACQUIRE_ROUNDS && outcome === null; round++) {
      let holds: CapacityHoldRow[];
      try {
        holds = await deps.store.listHolds(demand.provider);
      } catch (err) {
        outcome = `hold ledger read failed: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
      const open = holds.filter((h) => h.status === "RESERVED" || (h.status === "COMMITTED" && Date.parse(h.createdAt) > snapshotAt));
      const held = open.reduce((t, h) => t + h.units, 0);
      const effective = balance.available - held;
      if (demand.units > effective) {
        outcome = `demand ${demand.units} ${balance.unit} > available ${balance.available} − held ${held}`;
        break;
      }
      const seq = holds.reduce((m, h) => Math.max(m, h.seq), 0) + 1;
      const key = holdKey(demand.provider, seq);
      try {
        if (await deps.store.insertHold({ key, provider: demand.provider, projectId: input.requestId, units: demand.units, usd: demand.usd, createdAt: now() })) {
          outcome = { key, provider: demand.provider, units: demand.units };
        }
      } catch (err) {
        outcome = `hold ledger write failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (outcome === null) outcome = `could not acquire a hold after ${MAX_ACQUIRE_ROUNDS} rounds`;
    if (typeof outcome === "string") {
      await rollback();
      return { acquired: false, provider: demand.provider, reason: outcome };
    }
    acquired.push(outcome);
  }
  return { acquired: true, holds: acquired };
}

export async function settleCapacityHolds(store: CapacityHoldStore, holds: AcquiredHold[], status: "COMMITTED" | "REFUNDED"): Promise<void> {
  for (const h of holds) await store.settleHold(h.key, status);
}

/** A new attempt of the same request releases the open holds of its fenced-out predecessors. */
export async function releaseOpenHoldsForRequest(store: CapacityHoldStore, requestId: string): Promise<number> {
  const open = await store.listOpenHoldsForProject(requestId);
  let n = 0;
  for (const h of open) if (await store.settleHold(h.key, "REFUNDED")) n++;
  return n;
}

// ---- stores ----

type Row = { idempotency_key: string; project_id: string; provider: string; status: string; result_ref: string | null; created_at: string };
const rowToHold = (r: Row): CapacityHoldRow | null => {
  const seq = parseHoldSeq(r.idempotency_key);
  if (seq === null) return null;
  return { key: r.idempotency_key, seq, provider: r.provider, projectId: r.project_id, status: r.status as CapacityHoldStatus, units: unitsFromRef(r.result_ref), createdAt: r.created_at };
};

export function supabaseCapacityHoldStore(supabase: SupabaseClient): CapacityHoldStore {
  const table = "pi_paid_operations";
  const cols = "idempotency_key,project_id,provider,status,result_ref,created_at";
  return {
    async listHolds(provider) {
      const { data, error } = await supabase.from(table).select(cols).eq("method", CAPACITY_HOLD_METHOD).eq("provider", provider);
      if (error) throw new PaidLedgerUnavailableError(`hold list failed (${error.code ?? "?"}): ${error.message}`);
      return ((data ?? []) as Row[]).map(rowToHold).filter((h): h is CapacityHoldRow => h !== null);
    },
    async insertHold(row) {
      const { error } = await supabase.from(table).insert({
        idempotency_key: row.key,
        project_id: row.projectId,
        shot_id: `capacity:${row.provider}`,
        provider: row.provider,
        model: "*",
        method: CAPACITY_HOLD_METHOD,
        attempt_kind: "initial",
        reserved_usd: Math.max(0, row.usd),
        committed_usd: null,
        status: "RESERVED",
        provider_job_id: null,
        result_ref: `units:${row.units}`,
        created_at: row.createdAt,
        updated_at: row.createdAt,
      });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw new PaidLedgerUnavailableError(`hold insert failed (${error.code ?? "?"}): ${error.message}`);
    },
    async settleHold(key, status) {
      const { data, error } = await supabase.from(table).update({ status, committed_usd: status === "REFUNDED" ? 0 : null }).eq("idempotency_key", key).eq("status", "RESERVED").select("idempotency_key");
      if (error) throw new PaidLedgerUnavailableError(`hold settle failed (${error.code ?? "?"}): ${error.message}`);
      return Array.isArray(data) && data.length === 1;
    },
    async listOpenHoldsForProject(projectId) {
      const { data, error } = await supabase.from(table).select(cols).eq("method", CAPACITY_HOLD_METHOD).eq("project_id", projectId).eq("status", "RESERVED");
      if (error) throw new PaidLedgerUnavailableError(`hold list failed (${error.code ?? "?"}): ${error.message}`);
      return ((data ?? []) as Row[]).map(rowToHold).filter((h): h is CapacityHoldRow => h !== null);
    },
  };
}

export function memoryCapacityHoldStore(): CapacityHoldStore & { rows: Map<string, CapacityHoldRow> } {
  const rows = new Map<string, CapacityHoldRow>();
  return {
    rows,
    async listHolds(provider) { return [...rows.values()].filter((h) => h.provider === provider).map((h) => ({ ...h })); },
    async insertHold(row) {
      if (rows.has(row.key)) return false;
      rows.set(row.key, { key: row.key, seq: parseHoldSeq(row.key)!, provider: row.provider, projectId: row.projectId, status: "RESERVED", units: row.units, createdAt: row.createdAt });
      return true;
    },
    async settleHold(key, status) {
      const cur = rows.get(key);
      if (!cur || cur.status !== "RESERVED") return false;
      rows.set(key, { ...cur, status });
      return true;
    },
    async listOpenHoldsForProject(projectId) { return [...rows.values()].filter((h) => h.projectId === projectId && h.status === "RESERVED").map((h) => ({ ...h })); },
  };
}
