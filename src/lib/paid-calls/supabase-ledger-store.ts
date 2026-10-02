/**
 * `LedgerStore` (PI V1 engine) over the real `pi_paid_operations` table (migration 0023).
 * Service-role only (the table has RLS with no client policy). Fails closed: a store error is
 * thrown as PaidLedgerUnavailableError and the gate then makes no provider call.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerStore, PaidOperation, PaidOpStatus } from "@/lib/production-intelligence/ledger";
import { PaidLedgerUnavailableError } from "./errors";

export const PAID_OPERATIONS_TABLE = "pi_paid_operations";
const UNIQUE_VIOLATION = "23505";

type Row = {
  idempotency_key: string;
  project_id: string;
  shot_id: string;
  provider: string;
  model: string;
  method: string;
  attempt_kind: string;
  reserved_usd: number | string;
  committed_usd: number | string | null;
  status: PaidOpStatus;
  provider_job_id: string | null;
  result_ref: string | null;
  updated_at: string;
};

function toRow(op: PaidOperation): Row {
  return {
    idempotency_key: op.idempotencyKey,
    project_id: op.projectId,
    shot_id: op.shotId,
    provider: op.provider,
    model: op.model,
    method: op.method,
    attempt_kind: op.attemptKind,
    reserved_usd: op.reservedUsd,
    committed_usd: op.committedUsd,
    status: op.status,
    provider_job_id: op.providerJobId,
    result_ref: op.resultRef,
    updated_at: op.updatedAt,
  };
}

function fromRow(r: Row): PaidOperation {
  return {
    idempotencyKey: r.idempotency_key,
    projectId: r.project_id,
    shotId: r.shot_id,
    provider: r.provider,
    model: r.model,
    method: r.method,
    attemptKind: r.attempt_kind,
    reservedUsd: Number(r.reserved_usd),
    committedUsd: r.committed_usd === null ? null : Number(r.committed_usd),
    status: r.status,
    providerJobId: r.provider_job_id,
    resultRef: r.result_ref,
    updatedAt: r.updated_at,
  };
}

function patchRow(patch: Partial<PaidOperation>): Partial<Row> {
  const out: Partial<Row> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.committedUsd !== undefined) out.committed_usd = patch.committedUsd;
  if (patch.providerJobId !== undefined) out.provider_job_id = patch.providerJobId;
  if (patch.resultRef !== undefined) out.result_ref = patch.resultRef;
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export function supabaseLedgerStore(supabase: SupabaseClient): LedgerStore {
  return {
    async get(key) {
      const { data, error } = await supabase.from(PAID_OPERATIONS_TABLE).select("*").eq("idempotency_key", key).maybeSingle();
      if (error) throw new PaidLedgerUnavailableError(`read failed (${error.code ?? "?"}): ${error.message}`);
      return data ? fromRow(data as Row) : null;
    },
    async insert(op) {
      const { error } = await supabase.from(PAID_OPERATIONS_TABLE).insert(toRow(op));
      if (!error) return true;
      if (error.code === UNIQUE_VIOLATION) return false;
      throw new PaidLedgerUnavailableError(`insert failed (${error.code ?? "?"}): ${error.message}`);
    },
    async update(key, expected, patch) {
      const { data, error } = await supabase
        .from(PAID_OPERATIONS_TABLE)
        .update(patchRow(patch))
        .eq("idempotency_key", key)
        .eq("status", expected)
        .select("idempotency_key");
      if (error) throw new PaidLedgerUnavailableError(`update failed (${error.code ?? "?"}): ${error.message}`);
      return Array.isArray(data) && data.length === 1;
    },
  };
}
