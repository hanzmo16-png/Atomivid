import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { cancelScheduledProduction, requestPodcastVideo } from "@/lib/podcast/video-jobs";
import { episodeSpend, pendingNarration, readRunBudget } from "@/lib/podcast/pilot-server";
import { handleVideoRequest } from "@/lib/podcast/route-handlers";

/**
 * Owner-only production (narration if needed, then the editor render) in the background, within the episode's total
 * budget (historical spend + pending cost), its own limit of new spend for this run, and an optional one-shot scheduled
 * start. Body (a JSON object): { budgetUsd?, runBudgetUsd?, scheduleAt?, cancel?, confirm }. `confirm` is the fingerprint
 * of the configuration the owner reviewed (productionFingerprint); a stale one is refused with 409 so nothing starts from
 * an unseen setup. The logic lives in handleVideoRequest (src/lib/podcast/route-handlers.ts).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  return handleVideoRequest(request, id, { user: async () => user, service: createServiceClient, loadOwnedEpisode, cancelScheduledProduction, requestPodcastVideo, episodeSpend, pendingNarration, readRunBudget });
}
