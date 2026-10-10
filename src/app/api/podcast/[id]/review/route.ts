import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode } from "@/lib/podcast/server";
import { reviewProduction } from "@/lib/podcast/video-jobs";

/** Owner-only creative review of the delivered video. Body: { decision: "approve" | "reject", note? }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = (await request.json().catch(() => ({}))) as { decision?: unknown; note?: unknown };
  if (body.decision !== "approve" && body.decision !== "reject") return NextResponse.json({ error: "Decisión no válida." }, { status: 400 });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  const out = await reviewProduction(service, episode, body.decision, typeof body.note === "string" ? body.note : null);
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out);
}
