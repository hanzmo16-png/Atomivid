import type { SupabaseClient } from "@supabase/supabase-js";
import type { Job, JobStore } from "./jobs";
import { supabaseLedgerStore, PAID_OPERATIONS_TABLE } from "@/lib/paid-calls/supabase-ledger-store";
import { DISPATCH_METHOD, type DispatchLedger } from "./execution";

/** Service-only durable snapshots. Revision CAS prevents concurrent execution/approval. */
export function supabaseJobStore(client: SupabaseClient): JobStore {
  return {
    async get(id) {
      const { data, error } = await client.from("vfx_director_jobs").select("snapshot").eq("id", id).maybeSingle();
      if (error) throw new Error("VFX_STORE_UNAVAILABLE");
      return data?.snapshot as Job ?? null;
    },
    async insert(job) {
      const { error } = await client.from("vfx_director_jobs").insert({ id: job.id, owner_id: job.ownerId, revision: job.revision, snapshot: job });
      if (error?.code === "23505") return false;
      if (error) throw new Error("VFX_STORE_UNAVAILABLE"); return true;
    },
    async cas(job, expectedRevision) {
      const { data, error } = await client.from("vfx_director_jobs").update({ revision: job.revision, snapshot: job })
        .eq("id", job.id).eq("owner_id", job.ownerId).eq("revision", expectedRevision).select("id");
      if (error) throw new Error("VFX_STORE_UNAVAILABLE"); return data?.length === 1;
    },
  };
}

/** Dispatch records live in the existing write-ahead ledger (`pi_paid_operations`, USD 0 rows). */
export function supabaseDispatchLedger(client: SupabaseClient): DispatchLedger {
  const base = supabaseLedgerStore(client);
  return { ...base,
    async list(jobId) {
      const { data, error } = await client.from(PAID_OPERATIONS_TABLE).select("idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,provider_job_id,result_ref,updated_at")
        .eq("project_id", jobId).eq("method", DISPATCH_METHOD);
      if (error) throw new Error("VFX_LEDGER_UNAVAILABLE");
      return (data ?? []).map(r => ({ idempotencyKey: r.idempotency_key, projectId: r.project_id, shotId: r.shot_id, provider: r.provider, model: r.model,
        method: r.method, attemptKind: r.attempt_kind, reservedUsd: Number(r.reserved_usd), committedUsd: r.committed_usd === null ? null : Number(r.committed_usd),
        status: r.status, providerJobId: r.provider_job_id, resultRef: r.result_ref, updatedAt: r.updated_at }));
    } };
}
