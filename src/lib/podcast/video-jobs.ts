import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStalledRun, isStalledVideo, PODCAST_BACKGROUND_NARRATION_CHARS, type PodcastEpisode } from "./episode";

/**
 * In-app podcast production jobs. The web request only records the request and dispatches the worker
 * (.github/workflows/podcast-video.yml); narration (gated, resumable) and the editor v3 render run there.
 * Only the episode id travels in the public dispatch event.
 */
export type PodcastJobKind = "video" | "narration";

export async function dispatchPodcastJob(episodeId: string, kind: PodcastJobKind, env = process.env): Promise<boolean> {
  const token = env.GH_WORKER_TOKEN, repo = env.GH_WORKER_REPO;
  if (!token || !repo || !/^[^\s/]+\/[^\s/]+$/.test(repo)) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ event_type: "podcast-video", client_payload: { episodeId, kind } }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const DISPATCH_UNCONFIRMED = "La solicitud quedó guardada, pero no pudimos confirmar el inicio del trabajo. Pulsa «Reintentar»: no se cobra nada dos veces.";

export type VideoRequestResult = { ok: true; status: "queued" } | { error: string; status: number };

/** Owner asked for the episode video: queue it (from none/failed/dead run) and dispatch the worker. */
export async function requestPodcastVideo(service: SupabaseClient, episode: PodcastEpisode, now = Date.now()): Promise<VideoRequestResult> {
  if (episode.source === "upload" && episode.status !== "ready") return { error: "Sube y termina la grabación antes de producir el video.", status: 409 };
  if (episode.source === "tts" && (!episode.script || !episode.voice_id)) return { error: "El episodio no tiene guion o voz.", status: 409 };
  const state = episode.video_status ?? "none";
  if ((state === "queued" || state === "running") && !isStalledVideo(episode, now)) return { error: "El video ya se está produciendo. Puedes cerrar la app y volver más tarde.", status: 409 };
  const at = new Date(now).toISOString();
  let q = service.from("podcast_episodes").update({
    video_status: "queued", video_stage: "En cola", video_error: null, video_requested_at: at, video_heartbeat_at: at,
    video_run_token: randomUUID(), video_attempts: (episode.video_attempts ?? 0) + 1, updated_at: at,
  }).eq("id", episode.id).eq("user_id", episode.user_id);
  q = state === "queued" || state === "running" ? q.eq("video_status", state).eq("video_attempts", episode.video_attempts ?? 0) : q.in("video_status", ["none", "failed", "ready"]);
  const { data } = await q.select("id");
  if (!data || data.length !== 1) return { error: "Otra solicitud tomó este episodio. Recarga la página.", status: 409 };
  if (!(await dispatchPodcastJob(episode.id, "video"))) {
    await service.from("podcast_episodes").update({ video_status: "failed", video_error: DISPATCH_UNCONFIRMED, updated_at: new Date().toISOString() }).eq("id", episode.id).eq("video_status", "queued");
    return { error: DISPATCH_UNCONFIRMED, status: 503 };
  }
  return { ok: true, status: "queued" };
}

/** Long scripts are narrated by the worker (a single web request cannot hold ~30 minutes of synthesis). */
export function narrationRunsInBackground(episode: Pick<PodcastEpisode, "characters" | "source">): boolean {
  return episode.source === "tts" && episode.characters > PODCAST_BACKGROUND_NARRATION_CHARS;
}

/** Queue a background narration: marks the episode generating (claimable by the worker) and dispatches. */
export async function requestBackgroundNarration(service: SupabaseClient, episode: PodcastEpisode, now = Date.now()): Promise<VideoRequestResult> {
  if (episode.status === "ready") return { error: "El episodio ya está listo.", status: 409 };
  if (episode.status === "generating" && !isStalledRun(episode, now)) return { error: "La narración ya está en curso. Puedes cerrar la app y volver más tarde.", status: 409 };
  if (!(await dispatchPodcastJob(episode.id, "narration"))) return { error: DISPATCH_UNCONFIRMED, status: 503 };
  return { ok: true, status: "queued" };
}
