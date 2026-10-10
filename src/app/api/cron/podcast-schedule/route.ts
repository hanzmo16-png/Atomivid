import { createServiceClient } from "@/lib/supabase/service";
import { EPISODE_COLUMNS } from "@/lib/podcast/server";
import { appNoticeEnv, authorizedSchedulerTick, runSchedulerTick } from "@/lib/podcast/pilot-server";
import { dispatchPodcastJob } from "@/lib/podcast/video-jobs";

/**
 * Scheduler tick of the supervised pilot, called by the database (pg_cron + pg_net, every minute, only while a
 * scheduled production is due). Starts due one-shot productions; never creates any. Counts only in the response.
 */
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const service = createServiceClient();
  if (!(await authorizedSchedulerTick(service, request.headers.get("x-tick-token")))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const out = await runSchedulerTick(service, EPISODE_COLUMNS, (id) => dispatchPodcastJob(id, "video"), appNoticeEnv());
    return Response.json({ ok: true, ...out });
  } catch {
    console.error("[atomivid:pilot] scheduler tick incomplete; nothing was charged");
    return Response.json({ error: "Tick incomplete" }, { status: 503 });
  }
}
