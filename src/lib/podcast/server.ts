/**
 * Server orchestration of the podcast (routes call these after authenticating the owner).
 * Generation is fenced by a compare-and-set on the episode row (one run at a time; a dead run is
 * resumable after PODCAST_STALE_RUN_MS) and every paid chunk goes through the paid-call gate.
 */
import { randomUUID } from "node:crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVoiceIdentity, synthesizeVoice } from "@/lib/ai/voice";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { ensureJobSupplyReady } from "@/lib/supply/readiness";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import type { VoiceProvider } from "@/lib/providers/types";
import { narrateEpisode, NarrationCapError } from "./narrate";
import { estimatePodcast, podcastDemand, normalizeScript, PODCAST_STALE_RUN_MS, validateScript, type PodcastEpisode } from "./episode";
import { listAccountVoices, VoicesUnavailableError } from "./voices";

const BUCKET = "videos";
export const EPISODE_COLUMNS = "id,user_id,title,language,source,script,voice_id,voice_name,characters,estimated_usd,status,run_token,run_started_at,audio_path,audio_mime,duration_seconds,audio_sha256,audio_bytes,loudness,cost_usd,error,created_at,updated_at,video_status,video_stage,video_attempts,video_run_token,video_requested_at,video_heartbeat_at,video_path,video_bytes,video_sha256,video_duration_seconds,video_error,budget_usd,scheduled_at,video_checks,review_status,review_note,reviewed_at,publish_status,retry_count";

/** Vercel functions have no ffmpeg on PATH: use the bundled binary (workers keep their own). */
export function ensureBundledFfmpeg() {
  if (!process.env.FFMPEG_BIN) process.env.FFMPEG_BIN = ffmpegInstaller.path;
}

export async function loadOwnedEpisode(service: SupabaseClient, userId: string, id: string): Promise<PodcastEpisode | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await service.from("podcast_episodes").select(EPISODE_COLUMNS).eq("id", id).eq("user_id", userId).maybeSingle();
  return (data as PodcastEpisode | null) ?? null;
}

export type CreateInput = { title: unknown; script?: unknown; language?: unknown; voiceId?: unknown; source: "tts" | "upload" };

export async function createEpisode(service: SupabaseClient, userId: string, input: CreateInput): Promise<{ id: string } | { error: string; status: number }> {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  if (!title) return { error: "Escribe un título.", status: 400 };
  const language = input.language === "en" ? "en" : "es";
  if (input.source === "upload") {
    const { data, error } = await service.from("podcast_episodes").insert({ user_id: userId, title, language, source: "upload" }).select("id").single();
    return error || !data ? { error: "No se pudo crear el episodio.", status: 500 } : { id: data.id };
  }
  const script = normalizeScript(typeof input.script === "string" ? input.script : "");
  const invalid = validateScript(script);
  if (invalid) return { error: invalid, status: 400 };
  const voiceId = typeof input.voiceId === "string" ? input.voiceId.trim() : "";
  let voices;
  try { voices = await listAccountVoices(); } catch (e) { return { error: e instanceof VoicesUnavailableError ? e.customerMessage : "No se pudieron consultar las voces.", status: 503 }; }
  const voice = voices.find((v) => v.voiceId === voiceId);
  if (!voice) return { error: "Elige una de las voces disponibles en tu cuenta.", status: 400 };
  const e = estimatePodcast(script);
  const { data, error } = await service.from("podcast_episodes").insert({ user_id: userId, title, language, source: "tts", script, voice_id: voice.voiceId, voice_name: voice.name, characters: e.characters, estimated_usd: e.usd }).select("id").single();
  return error || !data ? { error: "No se pudo guardar el episodio.", status: 500 } : { id: data.id };
}

const PUBLIC_REASON: Record<string, string> = {
  "insufficient unreserved balance": "El saldo de ElevenLabs no alcanza para este episodio. Recarga caracteres en el proveedor y vuelve a intentarlo.",
  "provider funded spend ceiling": "Se alcanzaría el tope de gasto diario o mensual de ElevenLabs. Espera al siguiente periodo o ajusta el tope.",
  "global funded spend ceiling": "Se alcanzaría el tope global de gasto diario o mensual.",
  "funded global budget unconfigured": "El presupuesto global de producción no está configurado.",
  "new work paused": "El saldo de ElevenLabs está en rojo: no se inicia trabajo nuevo.",
  "supplier balance unavailable": "El saldo de ElevenLabs no está verificado o no alcanza. Pulsa «Actualizar disponibilidad»; si sigue igual, recarga en el proveedor.",
  "spend unavailable": "No se pudo leer el gasto acumulado; no se genera para no exceder los topes.",
  concurrency: "Ya hay otra narración en curso con este proveedor. Inténtalo en un minuto.",
};
function publicError(err: unknown): string {
  if (err instanceof SupplyUnavailableError) return PUBLIC_REASON[err.reason] ?? err.customerMessage;
  const name = err instanceof Error ? err.constructor.name : "";
  if (/Reconciliation|Uncertain|PaidResultUnavailable/i.test(name)) return "Una parte quedó en estado incierto con el proveedor (posible cobro sin respuesta). No se reintenta para no cobrar dos veces; requiere revisión.";
  return "No se pudo generar la narración. Lo ya generado se conserva y no se vuelve a cobrar; inténtalo de nuevo.";
}

/**
 * One generation run. Claim (CAS) → narrate (gated) → store → ready. Any failure leaves the episode
 * 'failed' with a clear message; chunks already paid stay stored for the next run.
 */
export async function runGeneration(service: SupabaseClient, episode: PodcastEpisode, now: () => number = Date.now, opts: { capUsd?: number | null } = {}): Promise<{ ok: true; episode: PodcastEpisode } | { error: string; status: number }> {
  if (episode.source !== "tts" || !episode.script || !episode.voice_id) return { error: "Este episodio no se genera con voz sintética.", status: 409 };
  if (episode.status === "ready") return { error: "El episodio ya está listo.", status: 409 };
  const stale = new Date(now() - PODCAST_STALE_RUN_MS).toISOString();
  const token = randomUUID();
  const claim = service.from("podcast_episodes").update({ status: "generating", run_token: token, run_started_at: new Date(now()).toISOString(), error: null, updated_at: new Date(now()).toISOString() })
    .eq("id", episode.id).eq("user_id", episode.user_id);
  const { data: claimed } = await (episode.status === "generating" ? claim.eq("status", "generating").lt("run_started_at", stale) : claim.in("status", ["draft", "failed"])).select("id");
  if (!claimed || claimed.length !== 1) return { error: "Ya hay una generación en curso para este episodio. Espera a que termine.", status: 409 };
  ensureBundledFfmpeg();
  const voiceId = episode.voice_id;
  const provider: VoiceProvider = { name: "elevenlabs", synthesize: async (text, language = "es", speed) => ({ ...(await synthesizeVoice(text, language, speed, voiceId)), mimeType: "audio/mpeg", extension: "mp3" }) };
  const fenced = (patch: Record<string, unknown>) => service.from("podcast_episodes").update({ ...patch, updated_at: new Date(now()).toISOString() }).eq("id", episode.id).eq("run_token", token);
  // A long narration (up to ~33 min of audio) can outlast PODCAST_STALE_RUN_MS: keep this run visibly alive so
  // nobody can claim it concurrently while it is still working. Fenced by the run token.
  const heartbeat = setInterval(() => { void Promise.resolve(fenced({ run_started_at: new Date(now()).toISOString() })).catch(() => undefined); }, 120_000);
  try {
    if (!process.env.ELEVENLABS_API_KEY?.trim()) throw new VoicesUnavailableError("La voz sintética no está configurada en el servidor.");
    // Same admission as a production start: a stale balance is re-read (billing GET), never assumed.
    const ready = await ensureJobSupplyReady(service, [podcastDemand({ characters: episode.characters, usd: Number(episode.estimated_usd) })], { refresh: true });
    if (!ready.ready) throw new SupplyUnavailableError(ready.failure?.provider ?? "elevenlabs", ready.failure?.reason ?? "unavailable");
    const out = await narrateEpisode({ ledger: supabaseLedgerStore(service), results: supabaseResultStore(service, BUCKET), voiceProvider: provider, voiceIdentity: getVoiceIdentity(episode.language, voiceId),
      putAudio: async (p, bytes, contentType) => { const { error } = await service.storage.from(BUCKET).upload(p, bytes, { contentType, upsert: true }); if (error) throw new Error("STORAGE"); }, capUsd: opts.capUsd ?? null }, episode);
    const { data } = await fenced({ status: "ready", audio_path: out.audioPath, audio_mime: "audio/mp4", duration_seconds: out.durationSeconds, audio_sha256: out.sha256, audio_bytes: out.bytes,
      loudness: out.loudness, cost_usd: out.costUsd, run_token: null, error: null }).select(EPISODE_COLUMNS);
    const row = (data?.[0] as PodcastEpisode | undefined);
    return row ? { ok: true, episode: row } : { error: "Otra ejecución tomó este episodio.", status: 409 };
  } catch (err) {
    const capped = err instanceof NarrationCapError;
    const message = err instanceof VoicesUnavailableError ? err.customerMessage
      : capped ? `La narración se detuvo antes de superar el límite autorizado (USD ${err.capUsd.toFixed(2)}; gastado en esta ejecución USD ${err.spentUsd.toFixed(4)}). Lo ya narrado se conserva y no se vuelve a cobrar.`
      : publicError(err);
    await fenced({ status: "failed", run_token: null, error: message });
    return { error: message, status: capped ? 402 : err instanceof SupplyUnavailableError ? 503 : 500 };
  } finally {
    clearInterval(heartbeat);
  }
}
