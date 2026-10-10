/** Runs only when the podcast worker step died (timeout/cancel/crash): leave a clear, retryable state. */
export {};
async function main() {
  const id = process.env.EPISODE_ID?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || process.env.JOB_KIND === "narration") return;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  await createServiceClient().from("podcast_episodes").update({
    video_status: "failed", video_stage: null, updated_at: new Date().toISOString(),
    video_error: "La producción se interrumpió. La narración y lo ya pagado se conservan; pulsa «Reintentar».",
  // Only a run that stopped beating (this dead one); a newer request has a fresh heartbeat and is left alone.
  }).eq("id", id).in("video_status", ["queued", "running"]).lt("video_heartbeat_at", new Date(Date.now() - 90_000).toISOString());
}
main().catch(() => { process.exitCode = 1; });
