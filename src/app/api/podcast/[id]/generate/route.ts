import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode, podcastV2Enabled, runGeneration } from "@/lib/podcast/server";
import { narrationRunsInBackground, requestBackgroundNarration } from "@/lib/podcast/video-jobs";
import { UNCERTAIN_CHARGE_MESSAGE, budgetDecision, narrationCapUsd, runUpperBoundUsd } from "@/lib/podcast/pilot";
import { episodeSpentUsd, narrationChunks, productionSpend } from "@/lib/podcast/pilot-server";
import { ensurePodcastSpendAuthorization } from "@/lib/podcast/spend-authorization-open";

// Short narrations run here (+ mastering). Long scripts (up to ~33 min of audio) are narrated by the background
// worker instead: a single 300 s request cannot hold them. Either way every chunk already generated is stored and
// reused without paying again.
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  // Podcast 2.1: a retry while a paid call has an unknown outcome could pay it twice → refused until reconciled
  // (same rule the background worker applies). An unreadable ledger also refuses (fail-closed).
  if (podcastV2Enabled()) {
    const spend = await productionSpend(service, episode.id).catch(() => null);
    if (!spend) return NextResponse.json({ error: "No se pudo leer el registro de gastos; no se genera para no cobrar a ciegas." }, { status: 503 });
    if (spend.uncertain > 0) return NextResponse.json({ error: UNCERTAIN_CHARGE_MESSAGE, uncertain: spend.uncertain }, { status: 409 });
  }
  // The episode's total budget, when set, also bounds a narration started on its own.
  const spentUsd = await episodeSpentUsd(service, episode.id);
  if (episode.budget_usd != null) {
    const budget = budgetDecision(episode, Number(episode.budget_usd), spentUsd);
    if (!budget.ok) return NextResponse.json({ error: budget.message }, { status: 402 });
  }
  // A narration started on its own is authorised for what the page showed (its estimate, as an upper bound): the
  // narration stops before any paid chunk past that, or past what is left of the total budget.
  const capUsd = narrationCapUsd(runUpperBoundUsd(Number(episode.estimated_usd) || 0, narrationChunks(episode)), episode.budget_usd == null ? null : Number(episode.budget_usd), spentUsd ?? 0);
  // PR #198: the DB refuses podcast paid calls without a stored authorization → record the owner's approval first.
  const authz = await ensurePodcastSpendAuthorization(service, episode.id, capUsd ?? Number(episode.estimated_usd), `app:narration:${user.id}:${new Date().toISOString()}`);
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });
  if (narrationRunsInBackground(episode)) {
    const queued = await requestBackgroundNarration(service, episode);
    return "error" in queued ? NextResponse.json({ error: queued.error }, { status: queued.status }) : NextResponse.json({ status: "queued", background: true }, { status: 202 });
  }
  const out = await runGeneration(service, episode, Date.now, { capUsd });
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json({ status: out.episode.status, costUsd: out.episode.cost_usd });
}
