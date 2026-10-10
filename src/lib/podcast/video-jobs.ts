import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStalledRun, isStalledVideo, PODCAST_BACKGROUND_NARRATION_CHARS, type PodcastEpisode } from "./episode";
import { attemptsDecision, budgetDecision, scheduleDecision } from "./pilot";

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

export type VideoRequestResult = { ok: true; status: "queued" | "scheduled" } | { error: string; status: number };
export type ProductionOptions = { budgetUsd?: number | null; scheduleAt?: string | null };

/**
 * Owner asked for the production (narration if needed + video): checks the per-production budget, the attempt
 * limit and the schedule; then either queues it and dispatches the worker now, or leaves it scheduled for the
 * worker's scheduled tick (one-shot). Compare-and-set on the row: two requests never start two runs.
 */
export async function requestPodcastVideo(service: SupabaseClient, episode: PodcastEpisode, options: ProductionOptions = {}, now = Date.now()): Promise<VideoRequestResult> {
  if (episode.source === "upload" && episode.status !== "ready") return { error: "Sube y termina la grabación antes de producir el video.", status: 409 };
  if (episode.source === "tts" && (!episode.script || !episode.voice_id)) return { error: "El episodio no tiene guion o voz.", status: 409 };
  const state = episode.video_status ?? "none";
  if ((state === "queued" || state === "running") && !isStalledVideo(episode, now)) return { error: "El video ya se está produciendo. Puedes cerrar la app y volver más tarde.", status: 409 };
  const budgetUsd = options.budgetUsd !== undefined ? options.budgetUsd : (episode.budget_usd ?? null);
  const budget = budgetDecision(episode, budgetUsd == null ? null : Number(budgetUsd));
  if (!budget.ok) return { error: budget.message, status: 402 };
  const attempts = attemptsDecision(episode);
  if (!attempts.ok) return { error: attempts.message, status: 429 };
  const schedule = scheduleDecision(options.scheduleAt, now);
  if (!schedule.ok) return { error: schedule.message, status: 400 };
  const at = new Date(now).toISOString();
  const common = { budget_usd: budgetUsd, video_error: null, video_checks: null, review_status: "pending", review_note: null, reviewed_at: null, publish_status: "held", updated_at: at };
  let q = service.from("podcast_episodes").update(schedule.at
    // Scheduled: no run token or attempt yet; the scheduled tick claims it like a fresh request.
    ? { ...common, video_status: "scheduled", video_stage: null, scheduled_at: schedule.at, video_requested_at: at }
    : { ...common, video_status: "queued", video_stage: "En cola", scheduled_at: null, video_requested_at: at, video_heartbeat_at: at, video_run_token: randomUUID(), video_attempts: (episode.video_attempts ?? 0) + 1 },
  ).eq("id", episode.id).eq("user_id", episode.user_id);
  q = state === "queued" || state === "running" ? q.eq("video_status", state).eq("video_attempts", episode.video_attempts ?? 0) : q.in("video_status", ["none", "failed", "ready", "blocked", "scheduled"]);
  const { data } = await q.select("id");
  if (!data || data.length !== 1) return { error: "Otra solicitud tomó este episodio. Recarga la página.", status: 409 };
  if (schedule.at) return { ok: true, status: "scheduled" };
  if (!(await dispatchPodcastJob(episode.id, "video"))) {
    await service.from("podcast_episodes").update({ video_status: "failed", video_error: DISPATCH_UNCONFIRMED, updated_at: new Date().toISOString() }).eq("id", episode.id).eq("video_status", "queued");
    return { error: DISPATCH_UNCONFIRMED, status: 503 };
  }
  return { ok: true, status: "queued" };
}

/** Owner cancels a scheduled production before it starts (nothing was charged). */
export async function cancelScheduledProduction(service: SupabaseClient, episode: PodcastEpisode): Promise<VideoRequestResult | { ok: true; status: "cancelled" }> {
  const { data } = await service.from("podcast_episodes").update({ video_status: episode.video_path ? "ready" : "none", scheduled_at: null, updated_at: new Date().toISOString() })
    .eq("id", episode.id).eq("user_id", episode.user_id).eq("video_status", "scheduled").select("id");
  return data?.length === 1 ? { ok: true, status: "cancelled" } : { error: "La producción ya no está programada.", status: 409 };
}

/** Creative review of a delivered video: only the owner decides; technical checks never approve anything. */
export async function reviewProduction(service: SupabaseClient, episode: PodcastEpisode, decision: "approve" | "reject", note: string | null): Promise<{ ok: true } | { error: string; status: number }> {
  if (episode.video_status !== "ready" || !episode.video_path) return { error: "Todavía no hay un video entregado para revisar.", status: 409 };
  const at = new Date().toISOString();
  const { data } = await service.from("podcast_episodes").update({
    review_status: decision === "approve" ? "approved" : "rejected", review_note: note?.trim().slice(0, 1000) || null, reviewed_at: at,
    // No upload integration yet: an approved video is published by hand from the download; a rejected one stays held.
    publish_status: decision === "approve" ? "manual" : "held", updated_at: at,
  }).eq("id", episode.id).eq("user_id", episode.user_id).eq("video_status", "ready").eq("video_sha256", episode.video_sha256 ?? "").select("id");
  return data?.length === 1 ? { ok: true } : { error: "El video cambió mientras lo revisabas. Recarga la página.", status: 409 };
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
