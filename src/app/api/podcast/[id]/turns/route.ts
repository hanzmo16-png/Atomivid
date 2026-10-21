import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode, podcastV2Enabled } from "@/lib/podcast/server";
import { applyTurnAction } from "@/lib/podcast/v2/turns";

const BUCKET = "videos";

/**
 * Podcast 2.0, por turno (sin gasto): {action:"ticket", mime, size} → URL de subida firmada para una grabación propia;
 * {action:"attach", turnId, path} → asigna la grabación (original conservado, sin TTS) al turno;
 * {action:"edit", turnId, text} → cambia el texto de UN turno (solo ese segmento se volverá a sintetizar).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!podcastV2Enabled()) return NextResponse.json({ error: "No disponible." }, { status: 404 });
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const storage = service.storage.from(BUCKET);
  const out = await applyTurnAction({
    userId: user.id, episode: episode as never, body,
    signUpload: async (p) => { const { data, error } = await storage.createSignedUploadUrl(p); return error || !data ? null : data.token; },
    download: async (p) => { const { data } = await storage.download(p); return data ? Buffer.from(await data.arrayBuffer()) : null; },
    save: async (patch) => { const { data } = await service.from("podcast_episodes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", episode.id).eq("user_id", user.id).in("status", ["draft", "failed", "ready"]).select("id"); return (data?.length ?? 0) === 1; },
  });
  return NextResponse.json(out.body, { status: out.status });
}
