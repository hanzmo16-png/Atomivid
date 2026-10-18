import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
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
  // A generation claim is tied to this user and run. Every terminal write must match the same token:
  // an older upload can never mark a newer run ready/failed after another tab took over.
  const runToken = randomUUID();
  const { data: claimed, error: claimError } = await service.from("podcast_episodes")
    .update({ status: "generating", run_token: runToken, run_started_at: new Date().toISOString(), error: null })
    .eq("id", episode.id).eq("user_id", user.id)
    .in("status", ["draft", "failed", "ready"]).select("id");
  if (claimError) return NextResponse.json({ error: "No se pudo reservar el procesamiento. Comprueba el estado antes de intentarlo de nuevo." }, { status: 500 });
  if (claimed?.length !== 1) return NextResponse.json({ error: "Ya se está procesando una grabación." }, { status: 409 });
  const fail = async (message: string, status = 400) => {
    const { data: persisted, error: saveError } = await service.from("podcast_episodes")
      .update({ status: "failed", run_token: null, error: message, updated_at: new Date().toISOString() })
      .eq("id", episode.id).eq("user_id", user.id).eq("status", "generating").eq("run_token", runToken).select("id");
    if (saveError || persisted?.length !== 1) {
      return NextResponse.json({ error: "No se pudo confirmar el estado de la grabación. Recarga antes de continuar; no inicies otra operación." }, { status: 500 });
    }
    return NextResponse.json({ error: message }, { status });
  };
  const { data: blob } = await storage.download(body.path);
  if (!blob) return fail("No se encontró la grabación subida. Vuelve a subirla.");
  ensureBundledFfmpeg();
  const mastered = await masterRecording(Buffer.from(await blob.arrayBuffer()), measureNarrationSeconds).catch(() => ({ error: "no se pudo procesar el audio" }));
  // Keep the staged upload until the final DB state is durably confirmed; a DB error
  // must not destroy the source file that would be needed for a controlled recovery.
  if ("error" in mastered) return fail(`Grabación rechazada: ${mastered.error}.`);
  const audioPath = podcastAudioPath(episode);
  const { error: upError } = await storage.upload(audioPath, mastered.bytes, { contentType: "audio/mp4", upsert: true });
  if (upError) return fail("No se pudo guardar el episodio. Inténtalo de nuevo.", 500);
  const { data: saved, error: saveError } = await service.from("podcast_episodes")
    .update({ status: "ready", run_token: null, audio_path: audioPath, audio_mime: "audio/mp4", duration_seconds: mastered.durationSeconds, audio_sha256: mastered.sha256,
      audio_bytes: mastered.bytes.length, loudness: mastered.loudness, cost_usd: 0, error: null, updated_at: new Date().toISOString() })
    .eq("id", episode.id).eq("user_id", user.id).eq("status", "generating").eq("run_token", runToken).select("id");
  // No success response for an error or a lost compare-and-set: neither proves a ready episode.
  // The mastered file may exist, so avoid saying "start again" or hiding the uncertain state.
  if (saveError || saved?.length !== 1) return NextResponse.json({
    error: "El audio se procesó, pero no pudimos confirmar que el episodio esté listo. Recarga su estado antes de volver a intentarlo.",
  }, { status: 500 });
  await storage.remove([body.path]).catch(() => undefined);
  return NextResponse.json({ status: "ready" });
}
