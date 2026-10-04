import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import { currentReviewBinding } from "./review-bindings";
import { reviewMaterial, matchesReviewBytes } from "./review-media-validation";
import { jobGates, type Job } from "./jobs";

/** Signed previews come only from committed results of the already-owned job. */
export async function reviewMedia(service: SupabaseClient, job: Job): Promise<Record<string, string>> {
  const { data, error } = await service.from("pi_paid_operations").select("result_ref")
    .eq("project_id", job.id).eq("status", "COMMITTED").in("method", ["text-to-image", "image-edit", "image-to-video"]);
  if (error) throw new Error("VFX_MATERIALS_UNAVAILABLE");
  const results = supabaseResultStore(service);
  const prefix = `${job.id}/paid/`;
  const registered = await Promise.all((data ?? []).filter(row => typeof row.result_ref === "string" && row.result_ref.startsWith(prefix) && row.result_ref.endsWith(".json")).map(async row => {
    const meta = await results.getJson<{ assetPath: string; sha256: string }>(row.result_ref);
    return reviewMaterial(meta, job.id);
  }));
  // Internal corrections are eligible only when their bytes match the current artifact.
  const correction = reviewMaterial(await results.getJson(`${job.id}/final-review/nyc-fixed.json`), job.id);
  if (correction) registered.push(correction);
  const urls: Record<string, string> = {};
  const verified = new Map<string, boolean>();
  for (const environment of job.plan.environments) for (const stage of ["styleframe", "motion"] as const) {
    const sha = jobGates(job, environment.id).artifacts[stage];
    const meta = registered.find(item => item?.sha256 === sha);
    if (!meta) continue;
    if (!verified.has(meta.assetPath)) verified.set(meta.assetPath, matchesReviewBytes(meta, await results.getBytes(meta.assetPath)));
    if (!verified.get(meta.assetPath)) continue;
    const { data: signed, error: signingError } = await service.storage.from("videos").createSignedUrl(meta.assetPath, 600);
    if (signingError || !signed?.signedUrl) throw new Error("VFX_MATERIAL_SIGNING_FAILED");
    urls[`${environment.id}:${stage}`] = signed.signedUrl;
  }
  const bindings = await results.getJson<unknown[]>(`${job.id}/review/bindings.json`);
  for (const value of Array.isArray(bindings) ? bindings : []) {
    const binding = currentReviewBinding(value, job);
    if (!binding || !matchesReviewBytes(binding, await results.getBytes(binding.assetPath))) continue;
    const { data: signed, error } = await service.storage.from("videos").createSignedUrl(binding.assetPath, 600);
    if (error || !signed?.signedUrl) throw new Error("VFX_MATERIAL_SIGNING_FAILED");
    urls[`${binding.environmentId ?? "global"}:${binding.stage}`] = `${signed.signedUrl}#t=${binding.startFrame / job.brief.fps},${binding.endFrame / job.brief.fps}`;
  }
  return urls;
}
