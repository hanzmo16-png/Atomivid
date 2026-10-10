/** Read-only diagnosis of the pilot scheduler (pg_cron job, recent runs, pg_net responses, scheduled rows). Aggregates only. */
import { connectResolved } from "./lib/supabase-db";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const { client } = await connectResolved();
  try {
    await client.query("begin read only");
    const q = async (name: string, sql: string) => { try { log(name, (await client.query(sql)).rows); } catch (e) { log(name, { error: e instanceof Error ? e.message.slice(0, 200) : "?" }); } };
    await q("CRON_JOB", "select jobname, schedule, active from cron.job where jobname='pilot-scheduler-tick'");
    await q("CRON_RUNS", "select status, left(coalesce(return_message,''),160) msg, start_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname='pilot-scheduler-tick' order by start_time desc limit 5");
    await q("NET_RESPONSES", "select status_code, left(coalesce(content::text,''),200) content, left(coalesce(error_msg,''),160) err, created from net._http_response order by created desc limit 5");
    await q("SCHEDULED", "select video_status, scheduled_at <= now() due, budget_usd, video_attempts, left(coalesce(video_error,''),120) err from public.podcast_episodes where video_status in ('scheduled','queued','running','blocked') order by updated_at desc limit 5");
    await q("NOTICES", "select kind, delivered_at is not null delivered, channel, left(coalesce(delivery_error,''),120) err, created_at from public.production_notices order by created_at desc limit 5");
    await q("SECRET", "select count(*)::int n, min(length(token)) len from public.pilot_scheduler_secret");
  } finally { await client.end(); }
}
main().catch((e) => { console.error("DIAG_FAILED", e instanceof Error ? e.message.slice(0, 200) : ""); process.exitCode = 1; });
