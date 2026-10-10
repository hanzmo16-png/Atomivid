import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { cancelScheduledProduction, requestPodcastVideo } from "@/lib/podcast/video-jobs";

/**
 * Owner-only production (narration if needed, then the editor render) in the background, with the maximum budget
 * for this production and an optional one-shot scheduled start. Body: { budgetUsd?, scheduleAt?, cancel? }.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = (await request.json().catch(() => ({}))) as { budgetUsd?: unknown; scheduleAt?: unknown; cancel?: unknown };
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  if (body.cancel === true) {
    const out = await cancelScheduledProduction(service, episode);
    return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out);
  }
  const budgetUsd = body.budgetUsd === undefined || body.budgetUsd === null || body.budgetUsd === "" ? undefined : Number(body.budgetUsd);
  if (budgetUsd !== undefined && !Number.isFinite(budgetUsd)) return NextResponse.json({ error: "El presupuesto no es un número válido." }, { status: 400 });
  const scheduleAt = typeof body.scheduleAt === "string" && body.scheduleAt ? body.scheduleAt : null;
  const out = await requestPodcastVideo(service, episode, { ...(budgetUsd === undefined ? {} : { budgetUsd }), scheduleAt });
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out, { status: 202 });
}
