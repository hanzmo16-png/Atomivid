import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode, runGeneration } from "@/lib/podcast/server";
import { narrationRunsInBackground, requestBackgroundNarration } from "@/lib/podcast/video-jobs";

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
  if (narrationRunsInBackground(episode)) {
    const queued = await requestBackgroundNarration(service, episode);
    return "error" in queued ? NextResponse.json({ error: queued.error }, { status: queued.status }) : NextResponse.json({ status: "queued", background: true }, { status: 202 });
  }
  const out = await runGeneration(service, episode);
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json({ status: out.episode.status, costUsd: out.episode.cost_usd });
}
