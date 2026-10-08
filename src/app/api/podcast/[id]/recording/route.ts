import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { podcastUser } from "@/lib/podcast/auth";
import { loadOwnedEpisode, ensureBundledFfmpeg } from "@/lib/podcast/server";
import { podcastAudioPath } from "@/lib/podcast/episode";
import { isRecordingPathFor, masterRecording, RECORDING_MAX_BYTES, RECORDING_MIME, recordingUploadPath } from "@/lib/podcast/recording";
import { measureNarrationSeconds } from "@/lib/video/avatar/measure-narration";

export const maxDuration = 300;
const BUCKET = "videos";

/**
 * Own recording. {action:"ticket", mime, size} → one-time signed upload URL to a server-chosen path.
 * {action:"finalize", path} → the server re-reads, validates, masters and stores the episode audio.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await podcastUser();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const service = createServiceClient();
  const episode = await loadOwnedEpisode(service, user.id, id);
  if (!episode || episode.source !== "upload") return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  if (episode.status === "generating") return NextResponse.json({ error: "Ya se está procesando una grabación." }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { action?: string; mime?: string; size?: number; path?: string } | null;
  const storage = service.storage.from(BUCKET);
  if (body?.action === "ticket") {
    if (!(RECORDING_MIME as readonly string[]).includes(body.mime ?? "")) return NextResponse.json({ error: "Formato no admitido. Usa MP3, M4A, WAV, WebM u Ogg." }, { status: 400 });
    if (!(Number(body.size) > 0) || Number(body.size) > RECORDING_MAX_BYTES) return NextResponse.json({ error: `El archivo debe pesar menos de ${RECORDING_MAX_BYTES / 1024 / 1024} MB.` }, { status: 400 });
    const path = recordingUploadPath(user.id, episode.id);
    const { data, error } = await storage.createSignedUploadUrl(path);
    if (error || !data) return NextResponse.json({ error: "No se pudo preparar la subida." }, { status: 500 });
    return NextResponse.json({ path, token: data.token });
  }
  if (body?.action !== "finalize" || !body.path || !isRecordingPathFor(user.id, episode.id, body.path)) return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  const { data: claimed } = await service.from("podcast_episodes").update({ status: "generating", run_started_at: new Date().toISOString(), error: null })
    .eq("id", episode.id).in("status", ["draft", "failed", "ready"]).select("id");
  if (!claimed?.length) return NextResponse.json({ error: "Ya se está procesando una grabación." }, { status: 409 });
  const fail = async (message: string, status = 400) => {
    await service.from("podcast_episodes").update({ status: "failed", error: message, updated_at: new Date().toISOString() }).eq("id", episode.id);
    return NextResponse.json({ error: message }, { status });
  };
  const { data: blob } = await storage.download(body.path);
  if (!blob) return fail("No se encontró la grabación subida. Vuelve a subirla.");
  ensureBundledFfmpeg();
  const mastered = await masterRecording(Buffer.from(await blob.arrayBuffer()), measureNarrationSeconds).catch(() => ({ error: "no se pudo procesar el audio" }));
  await storage.remove([body.path]).catch(() => undefined);
  if ("error" in mastered) return fail(`Grabación rechazada: ${mastered.error}.`);
  const audioPath = podcastAudioPath(episode);
  const { error: upError } = await storage.upload(audioPath, mastered.bytes, { contentType: "audio/mp4", upsert: true });
  if (upError) return fail("No se pudo guardar el episodio. Inténtalo de nuevo.", 500);
  await service.from("podcast_episodes").update({ status: "ready", audio_path: audioPath, audio_mime: "audio/mp4", duration_seconds: mastered.durationSeconds, audio_sha256: mastered.sha256,
    audio_bytes: mastered.bytes.length, loudness: mastered.loudness, cost_usd: 0, error: null, updated_at: new Date().toISOString() }).eq("id", episode.id);
  return NextResponse.json({ status: "ready" });
}
