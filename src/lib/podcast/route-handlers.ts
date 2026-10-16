/**
 * Bodies of POST /api/podcast and POST /api/podcast/[id]/video with their dependencies passed in, so the real handlers
 * run in tests with fake authentication, repository and queue (route files only wire the real ones).
 * Order in both: authenticated user → body is a JSON object (else a stable 400, before any field is read) → refusal of
 * options the server cannot run → (video) owner's episode → cancel, or confirmation of what was reviewed → enqueue.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PodcastEpisode } from "./episode";
import type { CreateInput } from "./server";
import type { ProductionOptions, VideoRequestResult } from "./video-jobs";
import { INVALID_BODY, isJsonObject, unsupportedOption } from "./production-contract";
import { checkConfirmation } from "./production-confirm";

type User = { id: string } | { error: string; status: number };
const invalid = () => NextResponse.json({ error: INVALID_BODY }, { status: 400 });

/** The parsed body when it is a JSON object; null for invalid JSON, null, arrays and primitives. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try { body = await request.json(); } catch { return null; }
  return isJsonObject(body) ? body : null;
}

export type CreateDeps = {
  user: () => Promise<User>;
  service: () => SupabaseClient;
  createEpisode: (service: SupabaseClient, userId: string, input: CreateInput) => Promise<{ id: string } | { error: string; status: number }>;
};

export async function handleCreateEpisode(request: Request, d: CreateDeps): Promise<Response> {
  const user = await d.user();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = await readJsonObject(request);
  if (!body) return invalid();
  const unsupported = unsupportedOption(body);
  if (unsupported) return NextResponse.json({ error: unsupported }, { status: 400 });
  const out = await d.createEpisode(d.service(), user.id, { title: body.title, script: body.script, language: body.language, voiceId: body.voiceId, source: body.source === "upload" ? "upload" : "tts" });
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out);
}

export type VideoDeps = {
  user: () => Promise<User>;
  service: () => SupabaseClient;
  loadOwnedEpisode: (service: SupabaseClient, userId: string, id: string) => Promise<PodcastEpisode | null>;
  cancelScheduledProduction: (service: SupabaseClient, episode: PodcastEpisode) => Promise<VideoRequestResult | { ok: true; status: "cancelled" }>;
  requestPodcastVideo: (service: SupabaseClient, episode: PodcastEpisode, options: ProductionOptions) => Promise<VideoRequestResult>;
  episodeSpend: (service: SupabaseClient, episodeId: string) => Promise<{ spentUsd: number; uncertain: number } | null>;
  pendingNarration: (service: SupabaseClient, episode: PodcastEpisode) => Promise<{ usd: number; chunks: number }>;
  readRunBudget: (service: SupabaseClient, episodeId: string) => Promise<{ available: boolean }>;
};

export async function handleVideoRequest(request: Request, id: string, d: VideoDeps): Promise<Response> {
  const user = await d.user();
  if ("error" in user) return NextResponse.json({ error: user.error }, { status: user.status });
  const body = await readJsonObject(request);
  if (!body) return invalid();
  const service = d.service();
  const episode = await d.loadOwnedEpisode(service, user.id, id);
  if (!episode) return NextResponse.json({ error: "Episodio no encontrado." }, { status: 404 });
  if (body.cancel === true) {
    const out = await d.cancelScheduledProduction(service, episode);
    return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out);
  }
  const unsupported = unsupportedOption(body);
  if (unsupported) return NextResponse.json({ error: unsupported }, { status: 400 });
  const confirmed = checkConfirmation(episode, body.confirm);
  if ("error" in confirmed) return NextResponse.json({ error: confirmed.error }, { status: confirmed.status });
  const budgetUsd = body.budgetUsd === undefined || body.budgetUsd === null || body.budgetUsd === "" ? undefined : Number(body.budgetUsd);
  if (budgetUsd !== undefined && !Number.isFinite(budgetUsd)) return NextResponse.json({ error: "El presupuesto no es un número válido." }, { status: 400 });
  const runBudgetUsd = body.runBudgetUsd === undefined || body.runBudgetUsd === null || body.runBudgetUsd === "" ? null : Number(body.runBudgetUsd);
  if (runBudgetUsd !== null && !Number.isFinite(runBudgetUsd)) return NextResponse.json({ error: "El límite por ejecución no es un número válido." }, { status: 400 });
  const scheduleAt = typeof body.scheduleAt === "string" && body.scheduleAt ? body.scheduleAt : null;
  const spend = await d.episodeSpend(service, episode.id);
  const pending = await d.pendingNarration(service, episode);
  const runBudgetColumn = (await d.readRunBudget(service, episode.id)).available;
  const out = await d.requestPodcastVideo(service, episode, { ...(budgetUsd === undefined ? {} : { budgetUsd }), scheduleAt, spentUsd: spend?.spentUsd ?? null, uncertainCharges: spend?.uncertain ?? 0,
    pendingUsd: pending.usd, pendingChunks: pending.chunks, runBudgetUsd, runBudgetColumn });
  return "error" in out ? NextResponse.json({ error: out.error }, { status: out.status }) : NextResponse.json(out, { status: 202 });
}

/** Signed links of the delivery, always derived from the authorized episode row (never from client input). */
export async function deliveryLinks(storage: { createSignedUrl: (path: string, ttl: number, opts?: { download: string }) => Promise<{ data: { signedUrl: string } | null }> }, episode: Pick<PodcastEpisode, "title" | "video_status" | "video_path">, ttl: number) {
  if ((episode.video_status ?? "none") !== "ready" || !episode.video_path) return { playUrl: null, downloadUrl: null };
  const safeName = episode.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 80) || "episodio";
  const playUrl = (await storage.createSignedUrl(episode.video_path, ttl)).data?.signedUrl ?? null;
  const downloadUrl = playUrl ? (await storage.createSignedUrl(episode.video_path, ttl, { download: `${safeName}.mp4` })).data?.signedUrl ?? null : null;
  return { playUrl, downloadUrl };
}
