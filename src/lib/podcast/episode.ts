/**
 * Minimal podcast (audio only, independent of video render). Reuses: the TTS splitter and stitcher of
 * Long Form, the paid-call gate (ledger + persisted results: a retry never pays twice for a chunk that
 * was already generated), supply admission inside the ledger (UNKNOWN balance or a spend cap refuses
 * before any provider call), and the product's loudness mastering (-16 LUFS / -1.5 dBTP).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPricingConfig } from "@/lib/billing/pricing";
import type { JobSupplyDemand } from "@/lib/supply/job";
import { ensureJobSupplyReady } from "@/lib/supply/readiness";
import { splitNarrationIntoSafeChunks } from "@/lib/video/long-form/timeline";
import { latestSnapshots, providerCheck, sourceLabel, type ProviderCheck } from "@/lib/video/long-form/production-preflight";

export const PODCAST_MIN_CHARS = 20;
export const PODCAST_MAX_CHARS = 30_000;
/** A run older than this is considered dead (function timeout) and may be resumed; paid chunks are reused. */
export const PODCAST_STALE_RUN_MS = 6 * 60_000;
/** Spoken Spanish/English narration averages ~15 characters per second; only for the estimate shown. */
const CHARS_PER_SECOND = 15;
export const ceil4 = (n: number) => Math.ceil(n * 10_000) / 10_000;

export type PodcastEpisode = {
  id: string; user_id: string; title: string; language: "es" | "en"; source: "tts" | "upload"; script: string | null;
  voice_id: string | null; voice_name: string | null; characters: number; estimated_usd: number; status: "draft" | "generating" | "ready" | "failed";
  run_token: string | null; run_started_at: string | null; audio_path: string | null; audio_mime: string | null; duration_seconds: number | null;
  audio_sha256: string | null; audio_bytes: number | null; loudness: unknown; cost_usd: number | null; error: string | null; created_at: string; updated_at: string;
  /** Video produced in-app by the worker (editor v3 engine). Absent on rows read before the video migration. */
  video_status?: PodcastVideoStatus; video_stage?: string | null; video_attempts?: number; video_run_token?: string | null;
  video_requested_at?: string | null; video_heartbeat_at?: string | null; video_path?: string | null; video_bytes?: number | null;
  video_sha256?: string | null; video_duration_seconds?: number | null; video_error?: string | null;
  /** Supervised pilot (budget, one-shot schedule, review, held publication). Absent before its migration. */
  budget_usd?: number | null; scheduled_at?: string | null; video_checks?: unknown; review_status?: "pending" | "approved" | "rejected";
  review_note?: string | null; reviewed_at?: string | null; publish_status?: "held" | "manual"; retry_count?: number;
};

export type PodcastVideoStatus = "none" | "scheduled" | "queued" | "running" | "ready" | "failed" | "blocked";
/** A queued/running video job without a heartbeat for this long is considered dead and may be retried. */
export const PODCAST_VIDEO_STALE_MS = 12 * 60 * 1000;
/** Above this many characters the narration runs in the background worker instead of the 300 s web request. */
export const PODCAST_BACKGROUND_NARRATION_CHARS = 6000;

export function isStalledVideo(e: Pick<PodcastEpisode, "video_status" | "video_heartbeat_at" | "video_requested_at">, now = Date.now()): boolean {
  if (e.video_status !== "queued" && e.video_status !== "running") return false;
  const last = Date.parse(e.video_heartbeat_at ?? e.video_requested_at ?? "");
  return !Number.isFinite(last) || now - last > PODCAST_VIDEO_STALE_MS;
}

export function normalizeScript(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function validateScript(text: string): string | null {
  if (text.length < PODCAST_MIN_CHARS) return `El guion debe tener al menos ${PODCAST_MIN_CHARS} caracteres.`;
  if (text.length > PODCAST_MAX_CHARS) return `El guion no puede superar ${PODCAST_MAX_CHARS.toLocaleString("es-MX")} caracteres (tiene ${text.length.toLocaleString("es-MX")}).`;
  return null;
}

export type PodcastEstimate = { characters: number; chunks: number; usd: number; estimatedSeconds: number; usdPer1kChars: number };

/** Characters billed = exactly what is sent to TTS (the chunks join back to the script). */
export function estimatePodcast(script: string): PodcastEstimate {
  const chunks = splitNarrationIntoSafeChunks(script);
  const characters = chunks.reduce((n, c) => n + c.length, 0);
  const usdPer1kChars = getPricingConfig().elevenLabsUsdPer1kChars;
  return { characters, chunks: chunks.length, usd: ceil4((characters / 1000) * usdPer1kChars), estimatedSeconds: Math.round(characters / CHARS_PER_SECOND), usdPer1kChars };
}

export function podcastDemand(e: Pick<PodcastEstimate, "characters" | "usd">): JobSupplyDemand {
  return { provider: "elevenlabs", unit: "character", units: e.characters, usd: e.usd };
}

export type PodcastCapacity = { check: ProviderCheck | null; ready: boolean; note: string | null };

/** Same admission rule as every production start (read-only here: no refresh, no reservation). */
export async function podcastCapacity(service: SupabaseClient, e: Pick<PodcastEstimate, "characters" | "usd">, refreshError?: string | null): Promise<PodcastCapacity> {
  try {
    const r = await ensureJobSupplyReady(service, [podcastDemand(e)], { refresh: false });
    const row = r.providers.find((p) => p.provider === "elevenlabs");
    const snap = (await latestSnapshots(service, ["elevenlabs"]).catch(() => new Map())).get("elevenlabs");
    const check = row ? { ...providerCheck(row, "character"), snapshotAt: snap?.checkedAt ?? null, source: snap?.reliability ?? null, sourceLabel: sourceLabel(snap?.reliability), refreshError: refreshError ?? null } : null;
    const note = !r.ready && r.failure?.provider === "production"
      ? r.failure.reason === "global funded spend ceiling" ? "Se alcanzaría el tope global de gasto diario o mensual." : "El presupuesto global de producción no está configurado o no se pudo leer."
      : null;
    return { check, ready: r.ready, note };
  } catch {
    return { check: null, ready: false, note: "No se pudo calcular la capacidad ahora. Se comprueba al generar; si no se confirma, no se genera ni se cobra." };
  }
}

export const podcastLedgerProject = (episodeId: string) => `podcast-${episodeId}`;
export const podcastAudioPath = (episode: Pick<PodcastEpisode, "id" | "user_id">) => `${episode.user_id}/podcasts/${episode.id}/episode.m4a`;

/** A 'generating' run that has not finished within PODCAST_STALE_RUN_MS (function timeout or crash). */
export function isStalledRun(e: Pick<PodcastEpisode, "status" | "run_started_at">, now: number = Date.now()): boolean {
  return e.status === "generating" && !!e.run_started_at && now - Date.parse(e.run_started_at) > PODCAST_STALE_RUN_MS;
}
