import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { cancelScheduledProduction, requestPodcastVideo } from "@/lib/podcast/video-jobs";
import { episodeSpend, pendingNarration, readRunBudget } from "@/lib/podcast/pilot-server";

/**
 * Owner-only production (narration if needed, then the editor render) in the background, within the episode's total
 * budget (historical spend + pending cost), its own limit of new spend for this run, and an optional one-shot scheduled
 * start. Body: { budgetUsd?, runBudgetUsd?, scheduleAt?, cancel? }.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = (await request.json().catch(() => ({}))) as { budgetUsd?: unknown; runBudgetUsd?: unknown; scheduleAt?: unknown; cancel?: unknown };
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  if (body.cancel === true) {
    const out = await cancelScheduledProduction(service, episode);
    return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out);
  }
  const budgetUsd = body.budgetUsd === undefined || body.budgetUsd === null || body.budgetUsd === "" ? undefined : Number(body.budgetUsd);
  if (budgetUsd !== undefined && !Number.isFinite(budgetUsd)) return NextResponse.json({ error: "El presupuesto no es un número válido." }, { status: 400 });
  const runBudgetUsd = body.runBudgetUsd === undefined || body.runBudgetUsd === null || body.runBudgetUsd === "" ? null : Number(body.runBudgetUsd);
  if (runBudgetUsd !== null && !Number.isFinite(runBudgetUsd)) return NextResponse.json({ error: "El límite por ejecución no es un número válido." }, { status: 400 });
  const scheduleAt = typeof body.scheduleAt === "string" && body.scheduleAt ? body.scheduleAt : null;
  const spend = await episodeSpend(service, episode.id);
  const pending = await pendingNarration(service, episode);
  const runBudgetColumn = (await readRunBudget(service, episode.id)).available;
  const out = await requestPodcastVideo(service, episode, { ...(budgetUsd === undefined ? {} : { budgetUsd }), scheduleAt, spentUsd: spend?.spentUsd ?? null, uncertainCharges: spend?.uncertain ?? 0,
    pendingUsd: pending.usd, pendingChunks: pending.chunks, runBudgetUsd, runBudgetColumn });
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out, { status: 202 });
}
