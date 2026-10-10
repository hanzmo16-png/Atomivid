/**
 * Supervised pilot, server side (I/O): spend of a production from the paid-call ledger, owner notices (one per run
 * and kind; delivered by the worker through GitHub, the channel the owner already receives), and the one-shot
 * scheduled start. See pilot.ts for the rules.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { paidResultPath, supabaseResultStore } from "@/lib/paid-calls/result-store";
import { podcastLedgerProject, type PodcastEpisode } from "./episode";
import { attemptsDecision, budgetDecision, noticeText, summarizeSpend, type LedgerRow, type NoticeKind, type SpendSummary } from "./pilot";

export async function productionSpend(service: SupabaseClient, episodeId: string): Promise<SpendSummary> {
  const projectId = podcastLedgerProject(episodeId);
  const { data, error } = await service.from("pi_paid_operations").select("idempotency_key,status,reserved_usd,committed_usd").eq("project_id", projectId);
  if (error) throw new Error("LEDGER_UNAVAILABLE");
  const rows = (data ?? []) as LedgerRow[];
  const results = supabaseResultStore(service, "videos");
  const stored = new Set<string>();
  for (const r of rows) {
    if (r.status === "COMMITTED" || r.status === "REFUNDED" || r.status === "RESERVED") continue;
    // An open row whose result is stored was delivered by the provider (reused at no cost): certain, not uncertain.
    if (await results.getJson(paidResultPath(projectId, r.idempotency_key, "json")).catch(() => null)) stored.add(r.idempotency_key);
  }
  return summarizeSpend(rows, stored);
}

export type Notice = { id: string; kind: NoticeKind; message: string };

/** Records a notice once per (episode, kind, run); returns null when it already existed (never notify twice). */
export async function recordNotice(service: SupabaseClient, episode: Pick<PodcastEpisode, "id" | "user_id">, kind: NoticeKind, runKey: string, detail?: string): Promise<Notice | null> {
  const message = noticeText(kind, detail);
  const { data, error } = await service.from("production_notices").insert({ user_id: episode.user_id, episode_id: episode.id, kind, run_key: runKey.slice(0, 80), message }).select("id").single();
  if (error || !data) return null;
  return { id: (data as { id: string }).id, kind, message };
}

export const NOTICE_ISSUE_TITLE = "Avisos de producción de Atomivid";
const GENERIC: Record<NoticeKind, string> = {
  delivered: "Una producción está lista para tu revisión. La publicación sigue detenida hasta que la apruebes.",
  blocked: "Una producción se detuvo y necesita tu atención.",
  budget: "Una producción no empezó por presupuesto insuficiente.",
};

/**
 * Delivers a notice as a comment on one tracking issue of the repository, mentioning the owner: GitHub then
 * notifies them by e-mail / mobile app with their own settings. The repository is public, so the comment says only
 * what happened and links to the app (sign-in required); details stay in the app.
 */
export async function deliverGithubNotice(service: SupabaseClient, notice: Notice, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const token = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY, mention = env.NOTICE_MENTION, app = env.APP_URL || "https://atomivid.vercel.app";
  const fail = async (reason: string) => { await service.from("production_notices").update({ delivery_error: reason.slice(0, 300) }).eq("id", notice.id); return false; };
  if (!token || !repo || !mention || !/^[A-Za-z0-9-]{1,39}$/.test(mention)) return fail("canal sin configurar (token, repositorio o usuario a mencionar)");
  const gh = (p: string, init?: RequestInit) => fetchImpl(`https://api.github.com/repos/${repo}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
  try {
    const list = await gh(`/issues?state=open&per_page=50&creator=${encodeURIComponent("github-actions[bot]")}`);
    let issue = list.ok ? ((await list.json()) as { number: number; title: string }[]).find((i) => i.title === NOTICE_ISSUE_TITLE)?.number : undefined;
    if (!issue) {
      const created = await gh("/issues", { method: "POST", body: JSON.stringify({ title: NOTICE_ISSUE_TITLE, body: `Avisos automáticos de entrega, bloqueo y presupuesto de las producciones de @${mention}. Los detalles están en la app (requiere iniciar sesión).` }) });
      if (!created.ok) return fail(`no se pudo crear el issue de avisos (${created.status})`);
      issue = ((await created.json()) as { number: number }).number;
    }
    const res = await gh(`/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body: `@${mention} ${GENERIC[notice.kind]}\n\nRevísalo en ${app}/dashboard/podcast` }) });
    if (!res.ok) return fail(`no se pudo publicar el aviso (${res.status})`);
    await service.from("production_notices").update({ channel: "github", delivered_at: new Date().toISOString(), delivery_error: null }).eq("id", notice.id);
    return true;
  } catch {
    return fail("error de red al avisar");
  }
}

/** Productions whose scheduled start has come (oldest first). */
export async function dueScheduled(service: SupabaseClient, columns: string, now = new Date(), limit = 3): Promise<PodcastEpisode[]> {
  const { data } = await service.from("podcast_episodes").select(columns).eq("video_status", "scheduled").lte("scheduled_at", now.toISOString()).order("scheduled_at", { ascending: true }).limit(limit);
  return (data ?? []) as unknown as PodcastEpisode[];
}

export type ClaimOutcome = { claimed: true; token: string } | { claimed: false; blocked?: { kind: NoticeKind; message: string } };

/**
 * Claims a due scheduled production (compare-and-set scheduled → queued with a fresh run token), re-checking the
 * budget and the attempt limit at start time. A failed check leaves it blocked with the reason (no charge).
 */
export async function claimScheduled(service: SupabaseClient, episode: PodcastEpisode): Promise<ClaimOutcome> {
  const at = new Date().toISOString();
  const budget = budgetDecision(episode, episode.budget_usd == null ? null : Number(episode.budget_usd));
  const attempts = attemptsDecision(episode);
  const refusal = !budget.ok ? { kind: "budget" as const, message: budget.message } : !attempts.ok ? { kind: "blocked" as const, message: attempts.message } : null;
  if (refusal) {
    const { data } = await service.from("podcast_episodes").update({ video_status: "blocked", video_error: refusal.message.slice(0, 500), scheduled_at: null, updated_at: at })
      .eq("id", episode.id).eq("video_status", "scheduled").select("id");
    return data?.length === 1 ? { claimed: false, blocked: refusal } : { claimed: false };
  }
  const token = randomUUID();
  const { data } = await service.from("podcast_episodes").update({ video_status: "queued", video_stage: "En cola", scheduled_at: null, video_run_token: token, video_attempts: (episode.video_attempts ?? 0) + 1, video_heartbeat_at: at, updated_at: at })
    .eq("id", episode.id).eq("video_status", "scheduled").eq("video_attempts", episode.video_attempts ?? 0).select("id");
  return data?.length === 1 ? { claimed: true, token } : { claimed: false };
}
