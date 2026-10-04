/** Complete ONLY the existing authorized form request through production helpers.
 * The real form/script HTTP flow has been observed; this isolated backend continuation
 * does not claim that render admission was clicked in the authenticated browser.
 */
import fs from "node:fs/promises";
import { createServiceClient } from "../src/lib/supabase/service";
import { readOwnerFormTrial, assertOwnerFormTrial, freezeOwnerFormRender } from "../src/lib/billing/owner-form-trial";
import { generateOwnerFormScript } from "../src/lib/video/owner-form-script";
import { checkScriptQuality, ScriptQualityError } from "../src/lib/video/script-quality";
import { targetWordsFor } from "../src/lib/video/script-pacing";
import { runRenderJob } from "../src/lib/video/run-job";
import type { GeneratedScript } from "../src/lib/providers/types";

const REQUEST = "34bc43f3-a53d-4daa-b8fa-bef3f1544b04";
async function main() {
  if (process.env.OWNER_FORM_TRIAL_WORKER !== "true" || !process.env.GITHUB_ACTIONS) throw new Error("FORM_TRIAL_ISOLATION_REQUIRED");
  const service = createServiceClient(), grant = await readOwnerFormTrial(service, REQUEST);
  if (!grant) throw new Error("FORM_TRIAL_NOT_AUTHORIZED");
  const request = await service.from("video_requests").select("id,user_id,mode,topic,style,language,duration_seconds,status,render_attempts,script_json,video_path")
    .eq("id", REQUEST).single();
  if (request.error || !request.data) throw new Error("FORM_TRIAL_REQUEST_UNAVAILABLE");
  const row = request.data;
  if (row.status === "completed" && row.render_attempts === 1 && row.video_path) {
    console.log("FORM_TRIAL_ALREADY_COMPLETED_NO_PROVIDER_CALLS"); return;
  }
  const user = await service.auth.admin.getUserById(row.user_id);
  if (user.error || !user.data.user) throw new Error("FORM_TRIAL_OWNER_UNVERIFIED");
  assertOwnerFormTrial(grant, row, user.data.user, "script");
  const result = await generateOwnerFormScript(service, grant);
  const quality = checkScriptQuality(result.script, { topic: grant.topic, targetWords: targetWordsFor(30), providerName: result.providerName });
  if (!quality.ok) throw new ScriptQualityError(quality);
  let save = service.from("video_requests").update({ status: "script_ready", script_json: result.script, error_message: null })
    .eq("id", REQUEST).eq("status", row.status).eq("render_attempts", 0);
  save = row.script_json ? save.eq("script_json", JSON.stringify(row.script_json)) : save.is("script_json", null);
  const saved = await save.select("id");
  if (saved.error || saved.data?.length !== 1) throw new Error("FORM_TRIAL_SCRIPT_STATE_CONFLICT");
  const reviewed = { ...row, status: "script_ready", script_json: result.script as GeneratedScript };
  assertOwnerFormTrial(grant, reviewed, user.data.user, "admission");
  await freezeOwnerFormRender(service, grant, result.script);
  const claim = await service.from("video_requests").update({ status: "processing", render_attempts: 1,
    error_message: null, progress_stage: "queued", render_started_at: new Date().toISOString(), render_worker: "github-actions" })
    .eq("id", REQUEST).eq("status", "script_ready").eq("render_attempts", 0).eq("script_json", JSON.stringify(result.script)).select("id");
  if (claim.error || claim.data?.length !== 1) throw new Error("FORM_TRIAL_RENDER_STATE_CONFLICT");
  await fs.writeFile(".render-attempt.json", JSON.stringify({ requestId: REQUEST, attempt: 1 }), { mode: 0o600 });
  console.log("FORM_TRIAL_REFINED_SCRIPT_SAVED_ONE_RENDER_CLAIMED");
  await runRenderJob(REQUEST, 1);
}
main().catch(error => { console.error(error instanceof ScriptQualityError ? error.result.issue : "FORM_TRIAL_BLOCKED_NO_AUTOMATIC_REPLAY"); process.exitCode = 1; });
