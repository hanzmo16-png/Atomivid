import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { podcastCapacity } from "@/lib/podcast/episode";
import { refreshDemandedCapacity } from "@/lib/video/long-form/refresh-capacity";

/** "Actualizar disponibilidad" for one episode: billing GET only (60 s reuse), never generates or charges. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode || episode.source !== "tts") return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  const outcome = await refreshDemandedCapacity(service, ["elevenlabs"]);
  const capacity = await podcastCapacity(service, { characters: episode.characters, usd: Number(episode.estimated_usd) }, outcome.errors.elevenlabs);
  return NextResponse.json({ capacity, checkedAt: new Date().toISOString() });
}
