import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import { jobGates, type Job } from "./jobs";

/** Signed previews come only from committed results of the already-owned job. */
export async function reviewMedia(service: SupabaseClient, job: Job): Promise<Record<string, string>> {
  const { data, error } = await service.from("pi_paid_operations").select("result_ref")
    .eq("project_id", job.id).eq("status", "COMMITTED").in("method", ["text-to-image", "image-to-video"]);
  if (error) throw new Error("VFX_MATERIALS_UNAVAILABLE");
  const results = supabaseResultStore(service);
  const prefix = `${job.id}/paid/`;
  const registered = await Promise.all((data ?? []).filter(row => typeof row.result_ref === "string" && row.result_ref.startsWith(prefix) && row.result_ref.endsWith(".json")).map(async row => {
    const meta = await results.getJson<{ assetPath: string; sha256: string }>(row.result_ref);
    if (!meta || typeof meta.assetPath !== "string" || !meta.assetPath.startsWith(prefix) || meta.assetPath.includes("..")
      || !/\.(png|jpg|jpeg|mp4)$/.test(meta.assetPath) || !/^[a-f0-9]{64}$/.test(meta.sha256)) return null;
    return meta;
  }));
  const urls: Record<string, string> = {};
  for (const environment of job.plan.environments) for (const stage of ["styleframe", "motion"] as const) {
    const sha = jobGates(job, environment.id).artifacts[stage];
    const meta = registered.find(item => item?.sha256 === sha);
    if (!meta) continue;
    const { data: signed, error: signingError } = await service.storage.from("videos").createSignedUrl(meta.assetPath, 600);
    if (signingError || !signed?.signedUrl) throw new Error("VFX_MATERIAL_SIGNING_FAILED");
    urls[`${environment.id}:${stage}`] = signed.signedUrl;
  }
  return urls;
}
