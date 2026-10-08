import { createServiceClient } from "@/lib/supabase/service";
import { CURATION_FILE_PATH, parseCurationFile, requestedContracts, type RequestedContract } from "@/lib/video/long-form/asset-curation";
import { getRealLongFormProviderNames, type ProductionPlan, type ProductionPlanBeatInput } from "@/lib/video/long-form/production-plan";
import { curationPlanShots } from "@/lib/video/long-form/curation-plan";
import { productPlan } from "@/lib/video/long-form/product-plan";
import { cinematicV6Enabled } from "@/lib/video/long-form/cinematic-v6-access";
import { editorialApprovalError } from "@/lib/video/long-form/editorial";
import { usesVisualIdentity } from "@/lib/video/long-form/production-plan-types";
import { isLongFormScriptJson } from "@/lib/video/long-form/script-json";
import type { CurationFile } from "@/lib/video/long-form/verified-assets";

const BUCKET = "videos";

export type CurationContext = { requestId: string; topic: string; requested: Map<string, RequestedContract>; file: CurationFile };

/**
 * Contexto de curaduría de UNA solicitud: los contratos que pide su plan v4
 * (calculados aquí con el mismo planner que el worker) y el archivo de
 * curaduría (dato, no autoridad). Solo lo llaman la página y las acciones
 * tras comprobar al curador.
 */
export async function loadCurationContext(requestId: string): Promise<CurationContext | null> {
  const service = createServiceClient();
  const { data: row } = await service.from("video_requests").select("user_id,status,duration_seconds,script_json,long_form_production_plan").eq("id", requestId).maybeSingle();
  if (!row || !isLongFormScriptJson(row.script_json)) return null;
  const script = row.script_json as unknown as { topic: string; beats: ProductionPlanBeatInput[] };
  let plan = row.long_form_production_plan as ProductionPlan | null | undefined;
  if (!plan) {
    // Preparation before confirmation is read-only: no plan, confirmation, quota
    // or render is written. Only an approved script and enabled owner qualify.
    if (row.status !== "script_ready" || editorialApprovalError(row.script_json)) return null;
    const { data: owner, error } = await service.auth.admin.getUserById(row.user_id);
    if (error || !cinematicV6Enabled(owner?.user)) return null;
    plan = productPlan({ beats: script.beats, topic: script.topic, strategy: "balanced", providers: getRealLongFormProviderNames(),
      requestedDurationSeconds: row.duration_seconds ?? undefined, cinematicV6: true }).plan;
  }
  if (!usesVisualIdentity(plan)) return null;
  const requested = requestedContracts(curationPlanShots(script.beats, script.topic, plan));
  let raw: unknown = null;
  const { data } = await service.storage.from(BUCKET).download(CURATION_FILE_PATH(requestId));
  if (data) {
    try {
      raw = JSON.parse(await data.text());
    } catch {
      raw = null;
    }
  }
  return { requestId, topic: script.topic, requested, file: parseCurationFile(raw, requestId) };
}

export async function saveCurationFile(file: CurationFile): Promise<void> {
  const { error } = await createServiceClient()
    .storage.from(BUCKET)
    .upload(CURATION_FILE_PATH(file.requestId), Buffer.from(JSON.stringify(file, null, 1)), { contentType: "application/json", upsert: true });
  if (error) throw new Error("No se pudo guardar la decisión de curaduría.");
}
