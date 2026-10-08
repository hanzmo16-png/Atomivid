import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode, runGeneration } from "@/lib/podcast/server";

// Narration of up to 30 000 characters (≤ 4 provider calls) + mastering. A run cut by the timeout is
// resumable: every chunk already generated is stored and reused without paying again.
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  const out = await runGeneration(service, episode);
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json({ status: out.episode.status, costUsd: out.episode.cost_usd });
}
