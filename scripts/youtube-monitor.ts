/**
 * Read-only YouTube monitor run for every linked video of a channel. Requires a connected
 * channel (migration 0024 + 0026 applied, OAuth consent done) and the GOOGLE_OAUTH_* /
 * YOUTUBE_TOKEN_ENC_KEY environment. It only issues GETs to allowlisted read endpoints,
 * never prints tokens, and writes idempotent rows.
 * Usage: npx tsx scripts/youtube-monitor.ts <channelId> <connectionId> [--dry-run]
 */
import { createServiceClient } from "@/lib/supabase/service";
import { supabaseYouTubeStore } from "@/lib/distribution/youtube/store";
import { tokenForConnection } from "@/lib/distribution/youtube/connect-flow";
import { monitorVideo } from "@/lib/distribution/youtube/monitor";
import { applyRun } from "@/lib/distribution/youtube/snapshots";

async function main() {
  const [channelId, connectionId, flag] = process.argv.slice(2);
  if (!channelId || !connectionId) { console.error("usage: youtube-monitor <channelId> <connectionId> [--dry-run]"); process.exit(2); }
  const dry = flag === "--dry-run";
  const store = supabaseYouTubeStore(createServiceClient());
  const links = await store.listLinks(channelId);
  if (!links.length) { console.log(`[youtube-monitor] no linked videos for ${channelId}`); return; }
  const accessToken = await tokenForConnection({ store, env: process.env, fetch: fetch as never }, connectionId);
  const now = new Date().toISOString();
  for (const link of links) {
    const run = await monitorVideo(link, { fetch: fetch as never, accessToken, now, refreshToken: () => tokenForConnection({ store, env: process.env, fetch: fetch as never }, connectionId) });
    const publishedAt = run.observation?.publishedAt ?? link.publishedAt;
    const snapshots = publishedAt ? applyRun(await store.listPerformanceSnapshots(link.channelId, link.videoId), run, publishedAt) : [];
    if (!dry) {
      await store.upsertRows(run.rows);
      if (run.observation) await store.upsertObservation(run.observation);
      if (run.channel) await store.saveChannelSnapshot(run.channel);
      await store.upsertPerformanceSnapshots(snapshots);
    }
    console.log(`[youtube-monitor] ${link.projectId} -> ${link.videoId}: ${run.outcome}, ${run.rows.length} rows, windows ${run.windowsCollected.join("/") || "-"}, not due ${run.windowsNotDue.join("/") || "-"}, failures ${run.failures.map((f) => f.step + ":" + f.kind).join(",") || "-"}, snapshots ${snapshots.map((s) => s.window + "=" + s.status).join(" ")}${dry ? " (dry run, nothing written)" : ""}`);
  }
}
main().catch((e) => { console.error(`[youtube-monitor] ${e instanceof Error ? e.message : e}`); process.exit(1); });
