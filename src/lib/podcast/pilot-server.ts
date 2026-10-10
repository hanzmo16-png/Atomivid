/**
 * Supervised pilot, server side (I/O): spend of a production from the paid-call ledger, owner notices (one per run
 * and kind; delivered by the worker through GitHub, the channel the owner already receives), and the one-shot
 * scheduled start. See pilot.ts for the rules.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { getPricingConfig } from "@/lib/billing/pricing";
import { hasStoredVoiceMeta } from "@/lib/paid-calls/gated-providers";
import { paidResultPath, supabaseResultStore } from "@/lib/paid-calls/result-store";
import { splitNarrationIntoSafeChunks } from "@/lib/video/long-form/timeline";
import { ceil4, estimatePodcast, podcastLedgerProject, type PodcastEpisode } from "./episode";
import { isNoticeIssue, NOTICE_ISSUE_TITLE } from "./notice-check";
import { budgetDecision, historicalSpendUsd, MAX_PRODUCTION_ATTEMPTS, noticeText, remainingCostUsd, runBudgetDecision, summarizeSpend, UNCERTAIN_CHARGE_MESSAGE, type LedgerRow, type NoticeKind, type RunBudget, type SpendSummary } from "./pilot";

const LEDGER_PAGE = 1000, LEDGER_MAX_PAGES = 20;

/** Every paid-call row of the episode, paged (a truncated read would undercount the spend: it fails closed instead). */
async function ledgerRows(service: SupabaseClient, projectId: string): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  for (let page = 0; page < LEDGER_MAX_PAGES; page++) {
    const { data, error } = await service.from("pi_paid_operations").select("idempotency_key,status,reserved_usd,committed_usd").eq("project_id", projectId)
      .order("idempotency_key", { ascending: true }).range(page * LEDGER_PAGE, page * LEDGER_PAGE + LEDGER_PAGE - 1);
    if (error) throw new Error("LEDGER_UNAVAILABLE");
    const batch = (data ?? []) as LedgerRow[];
    rows.push(...batch);
    if (batch.length < LEDGER_PAGE) return rows;
  }
  throw new Error("LEDGER_TOO_LARGE");
}

export async function productionSpend(service: SupabaseClient, episodeId: string): Promise<SpendSummary> {
  const projectId = podcastLedgerProject(episodeId);
  const rows = await ledgerRows(service, projectId);
  const results = supabaseResultStore(service, "videos");
  const stored = new Set<string>();
  for (const r of rows) {
    if (r.status === "COMMITTED" || r.status === "REFUNDED" || r.status === "RESERVED") continue;
    // An open row whose result is stored was delivered by the provider (reused at no cost): certain, not uncertain.
    if (await results.getJson(paidResultPath(projectId, r.idempotency_key, "json")).catch(() => null)) stored.add(r.idempotency_key);
  }
  return summarizeSpend(rows, stored);
}

/**
 * The run limit stored with the request (`run_budget_usd`), read on its own so that every other query keeps working
 * before its migration is applied. Unreadable (column missing or read error) → available: false → no new spend.
 */
export async function readRunBudget(service: SupabaseClient, episodeId: string): Promise<RunBudget> {
  try {
    const { data, error } = await service.from("podcast_episodes").select("run_budget_usd").eq("id", episodeId).maybeSingle();
    if (error) return { available: false, value: null };
    const v = (data as { run_budget_usd?: unknown } | null)?.run_budget_usd;
    return { available: true, value: v == null ? null : Number(v) };
  } catch { return { available: false, value: null }; }
}

/** Number of paid chunks of a synthetic narration (each one is a separate reservation). */
export const narrationChunks = (episode: Pick<PodcastEpisode, "source" | "script">) => (episode.source === "tts" && episode.script ? estimatePodcast(episode.script).chunks : 1);

/** Historical spend for the total budget (uncertain charges included) and how many charges are uncertain; null = unreadable. */
export type EpisodeSpend = { spentUsd: number; uncertain: number };
export async function episodeSpend(service: SupabaseClient, episodeId: string): Promise<EpisodeSpend | null> {
  return productionSpend(service, episodeId).then((s) => ({ spentUsd: historicalSpendUsd(s), uncertain: s.uncertain }), () => null);
}
export async function episodeSpentUsd(service: SupabaseClient, episodeId: string): Promise<number | null> {
  return (await episodeSpend(service, episodeId))?.spentUsd ?? null;
}

/**
 * What a synthetic narration still has to pay: the reservation of every chunk whose paid result is not stored yet
 * (chunks already paid are in the historical spend and are reused at USD 0, so they are not counted twice).
 * A chunk whose metadata cannot be read counts as unpaid (conservative).
 */
export async function pendingNarration(service: SupabaseClient, episode: PodcastEpisode): Promise<{ usd: number; chunks: number }> {
  if (episode.source !== "tts" || episode.status === "ready" || !episode.script || !episode.voice_id) return { usd: remainingCostUsd(episode), chunks: 1 };
  const deps = { results: supabaseResultStore(service, "videos"), requestId: podcastLedgerProject(episode.id), voiceProvider: { name: "elevenlabs" }, voiceIdentity: getVoiceIdentity(episode.language, episode.voice_id) };
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  let usd = 0, chunks = 0;
  for (const chunk of splitNarrationIntoSafeChunks(episode.script)) {
    if (await hasStoredVoiceMeta(deps, chunk, episode.language).catch(() => false)) continue;
    usd += ceil4((chunk.length / 1000) * rate);
    chunks++;
  }
  return { usd: ceil4(usd), chunks: Math.max(1, chunks) };
}

export type Notice = { id: string; kind: NoticeKind; message: string };

/** Records a notice once per (episode, kind, run); returns null when it already existed (never notify twice). */
export async function recordNotice(service: SupabaseClient, episode: Pick<PodcastEpisode, "id" | "user_id">, kind: NoticeKind, runKey: string, detail?: string): Promise<Notice | null> {
  const message = noticeText(kind, detail);
  const { data, error } = await service.from("production_notices").insert({ user_id: episode.user_id, episode_id: episode.id, kind, run_key: runKey.slice(0, 80), message }).select("id").single();
  if (error || !data) return null;
  return { id: (data as { id: string }).id, kind, message };
}

export { isNoticeIssue, NOTICE_ISSUE_TITLE } from "./notice-check";
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
    // Oldest trusted issue with the title (a later look-alike by someone else is ignored).
    const list = await gh(`/issues?state=open&per_page=100&sort=created&direction=asc`);
    let issue = list.ok ? ((await list.json()) as { number: number; title: string; user?: { login?: string } }[]).find((i) => isNoticeIssue(i, mention))?.number : undefined;
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
/** A scheduled start whose spend cannot be verified this long after its time is blocked (the owner is told), not left stuck. */
export const SCHEDULE_VERIFY_GRACE_MS = 6 * 3600_000;

export async function claimScheduled(service: SupabaseClient, episode: PodcastEpisode, spend: EpisodeSpend | null, run: RunBudget, pending?: { usd: number; chunks: number }, now = Date.now()): Promise<ClaimOutcome> {
  const at = new Date(now).toISOString();
  const budget = budgetDecision(episode, episode.budget_usd == null ? null : Number(episode.budget_usd), spend?.spentUsd ?? null, pending?.usd);
  const runCheck = runBudgetDecision(budget.remainingUsd, pending?.chunks ?? narrationChunks(episode), run);
  // Ledger or run limit unreadable: not the owner's refusal. Retry on the next tick; after the grace period, block it
  // with a notice so it never stays scheduled forever.
  const unverifiable = (!budget.ok && spend == null) || (!runCheck.ok && !run.available);
  const late = now - Date.parse(episode.scheduled_at ?? at) > SCHEDULE_VERIFY_GRACE_MS;
  if (unverifiable && !late) return { claimed: false };
  // The request already decided new production vs retry (retry_count); failed dispatches add to it.
  const attempts = (episode.retry_count ?? 0) >= MAX_PRODUCTION_ATTEMPTS
    ? { ok: false as const, message: `La producción programada no se pudo iniciar tras ${MAX_PRODUCTION_ATTEMPTS} intentos. Revisa el estado antes de reprogramarla.` }
    : { ok: true as const };
  const refusal = unverifiable ? { kind: "blocked" as const, message: "No se pudo verificar el gasto ni el límite de la producción programada durante 6 horas; no se inició nada. Revisa el estado y vuelve a programarla." }
    : spend && spend.uncertain > 0 ? { kind: "blocked" as const, message: UNCERTAIN_CHARGE_MESSAGE }
    : !budget.ok ? { kind: "budget" as const, message: budget.message } : !runCheck.ok ? { kind: "budget" as const, message: runCheck.message } : !attempts.ok ? { kind: "blocked" as const, message: attempts.message } : null;
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

/** Constant-time comparison of the scheduler tick token with the one stored in the service-only table. */
export async function authorizedSchedulerTick(service: SupabaseClient, presented: string | null): Promise<boolean> {
  if (!presented || presented.length < 48) return false;
  const { data } = await service.from("pilot_scheduler_secret").select("token").eq("id", 1).maybeSingle();
  const expected = (data as { token?: string } | null)?.token;
  if (!expected || expected.length !== presented.length) return false;
  const { timingSafeEqual } = await import("node:crypto");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

/**
 * One scheduler tick (called by the database every minute while something is due): claims each due production
 * and dispatches the worker. A failed dispatch puts it back to "scheduled" (the claim counted an attempt, so a
 * dispatch that keeps failing ends blocked by the attempt limit); a budget/attempt refusal blocks it with ONE notice.
 */
export async function runSchedulerTick(service: SupabaseClient, columns: string, dispatch: (episodeId: string, kind?: "video" | "notices") => Promise<boolean>) {
  const due = await dueScheduled(service, columns, new Date(), 3);
  const out = { due: due.length, dispatched: 0, blocked: 0, requeued: 0 };
  for (const ep of due) {
    const claim = await claimScheduled(service, ep, await episodeSpend(service, ep.id), await readRunBudget(service, ep.id), await pendingNarration(service, ep));
    if (claim.claimed) {
      if (await dispatch(ep.id, "video")) { out.dispatched++; continue; }
      await service.from("podcast_episodes").update({ video_status: "scheduled", scheduled_at: new Date().toISOString(), video_stage: null, retry_count: (ep.retry_count ?? 0) + 1, updated_at: new Date().toISOString() })
        .eq("id", ep.id).eq("video_run_token", claim.token).eq("video_status", "queued");
      out.requeued++;
    } else if (claim.blocked) {
      out.blocked++;
      const notice = await recordNotice(service, ep, claim.blocked.kind, `scheduled-${ep.video_requested_at ?? ep.id}`, claim.blocked.message);
      // Delivered by the worker as the Actions bot: a comment written with the owner's own token never notifies them.
      if (notice) await dispatch(ep.id, "notices");
    }
  }
  return out;
}


/** Delivers every notice not yet delivered (last 7 days). Run by the worker, i.e. as the GitHub Actions bot. */
export async function deliverPendingNotices(service: SupabaseClient, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<{ pending: number; delivered: number }> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data } = await service.from("production_notices").select("id,kind,message").is("delivered_at", null).gte("created_at", since).order("created_at", { ascending: true }).limit(20);
  let delivered = 0;
  for (const n of (data ?? []) as Notice[]) if (await deliverGithubNotice(service, n, env, fetchImpl)) delivered++;
  return { pending: data?.length ?? 0, delivered };
}
