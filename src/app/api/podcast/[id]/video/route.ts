import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { requestPodcastVideo } from "@/lib/podcast/video-jobs";

/** Owner-only: produce the episode video in the background (narration first if needed, then the editor render). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  const out = await requestPodcastVideo(service, episode);
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out, { status: 202 });
}
