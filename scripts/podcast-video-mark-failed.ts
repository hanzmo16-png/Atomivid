/** Runs only when the podcast worker step died (timeout/cancel/crash): leave a clear, retryable state. */
export {};
import { readFile } from "node:fs/promises";

async function main() {
  const fromFile = process.env.PODCAST_TOKEN_FILE ? (await readFile(`${process.env.PODCAST_TOKEN_FILE}.episode`, "utf8").catch(() => "")).trim() : "";
  const id = process.env.EPISODE_ID?.trim() || fromFile;
  if (!/^[0-9a-f-]{36}$/i.test(id) || process.env.JOB_KIND === "narration") return;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  // The run token this job claimed (written by the worker right after its claim), when it got that far.
  const token = process.env.PODCAST_TOKEN_FILE ? (await readFile(process.env.PODCAST_TOKEN_FILE, "utf8").catch(() => "")).trim() : "";
  const patch = {
    video_status: "failed", video_stage: null, updated_at: new Date().toISOString(),
    video_error: "La producción se interrumpió. La narración y lo ya pagado se conservan; pulsa «Reintentar».",
  };
  const service = createServiceClient();
  const query = service.from("podcast_episodes").update(patch).eq("id", id).in("video_status", ["queued", "running"]);
  // With the token: exactly this job's run, even when it was cancelled seconds after its last heartbeat; a newer
  // request carries another token and is left alone. Without it (died before claiming): only a run that stopped beating.
  const { data } = await (token ? query.eq("video_run_token", token) : query.lt("video_heartbeat_at", new Date(Date.now() - 90_000).toISOString())).select("id,user_id");
  // One "blocked" notice for this run (the owner may have closed the app); never one per step.
  const row = data?.[0] as { id: string; user_id: string } | undefined;
  if (row && token) {
    const pilot = await import("../src/lib/podcast/pilot-server");
    const notice = await pilot.recordNotice(service, row, "blocked", token, patch.video_error);
    if (notice) await pilot.deliverGithubNotice(service, notice);
  }
}
main().catch(() => { process.exitCode = 1; });
