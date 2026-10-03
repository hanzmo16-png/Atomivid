import type { SupabaseClient } from "@supabase/supabase-js";
import type { Job, JobStore } from "./jobs";

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
