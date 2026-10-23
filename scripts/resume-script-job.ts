/** Owner-authorised resume of one failed script job (see src/lib/video/long-form/script-job-resume.ts). */
import { createClient } from "@supabase/supabase-js";
import { resumeScriptJob } from "../src/lib/video/long-form/script-job-resume";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await resumeScriptJob(db, { jobId: String(process.env.JOB_ID ?? "").trim(), expectedErrorCode: String(process.env.EXPECTED_ERROR_CODE ?? "").trim(),
    expectedRetryCount: Number(process.env.EXPECTED_RETRY_COUNT), confirm: String(process.env.CONFIRM ?? "").trim() });
  console.log("RESUME", JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 200)); process.exitCode = 1; });
