/**
 * Signed, secret-free probe of what the RUNNING deployment sees for the voice provider.
 * It reports presence only (never a value), env var NAMES matching ELEVEN, the deployment's
 * commit, and the account's voice count / whether "Hans podcast" exists (free GET, no audio).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { listAccountVoices, VoicesUnavailableError } from "@/lib/podcast/voices";
import { heygenApiSnapshot } from "@/lib/supply/heygen";

export const PROVIDER_CONFIG_PATH = "/api/internal/provider-config";

export function providerConfigSignature(secret: string, nonce: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`atomivid-provider-config-v1\nPOST\n${PROVIDER_CONFIG_PATH}\n${nonce}\n${timestamp}`).digest("hex");
}

export function validProviderConfigSignature(secret: string | undefined, nonce: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !/^[0-9a-f-]{36}$/i.test(nonce) || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(providerConfigSignature(secret, nonce, timestamp)));
}

export type ProviderConfigReport = {
  vercelEnv: string | null;
  commit: string | null;
  elevenlabsKey: "present" | "blank" | "missing";
  elevenEnvNames: string[];
  voices: { ok: true; count: number; hansPodcast: boolean; userVoice: { found: boolean; category: string | null } } | { ok: false; error: string };
  /** Which provider credentials this runtime has (presence only). */
  keys: Record<string, "present" | "blank" | "missing">;
  heygen: HeygenProbe;
};

/** Public part: categories/booleans only. `sealed` (balance, raw billing_type) must only be printed encrypted. */
export type HeygenProbe = {
  key: "present" | "blank" | "missing" | "masked";
  usersMe: { http: number | null; transportError: boolean };
  shape: { billingTypeWallet: boolean; walletPresent: boolean; currency: "usd" | "credits" | "other" | "missing"; balanceNumeric: boolean; balanceNonNegative: boolean } | null;
  snapshot: { reliability: string; unit: string; health: string; availablePresent: boolean };
  legacyUsdWalletReader: boolean;
  sealed: { billingType: string | null; currency: string | null; balance: number | null } | null;
};

export async function heygenProbe(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<HeygenProbe> {
  const raw = env.HEYGEN_API_KEY;
  const key: HeygenProbe["key"] = raw === undefined ? "missing" : !raw.trim() ? "blank" : /[•●*\s]/.test(raw.trim()) ? "masked" : "present";
  // Same reader production uses for supply (identities discarded inside).
  const snap = await heygenApiSnapshot(fetchImpl, { HEYGEN_API_KEY: raw?.trim() || undefined }, new Date().toISOString());
  const out: HeygenProbe = { key, usersMe: { http: null, transportError: false }, shape: null,
    snapshot: { reliability: snap.reliability, unit: snap.unit, health: snap.health, availablePresent: snap.available !== null }, legacyUsdWalletReader: false, sealed: null };
  if (key !== "present") return out;
  try {
    const r = await fetchImpl("https://api.heygen.com/v3/users/me", { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { "X-Api-Key": raw!.trim() } });
    out.usersMe.http = r.status;
    if (r.ok) {
      const d = ((await r.json().catch(() => null)) as { data?: { billing_type?: unknown; wallet?: { currency?: unknown; remaining_balance?: unknown } } } | null)?.data;
      const c = d?.wallet?.currency, b = d?.wallet?.remaining_balance;
      out.shape = { billingTypeWallet: d?.billing_type === "wallet", walletPresent: !!d?.wallet, currency: c === "usd" ? "usd" : c === "credits" ? "credits" : c === undefined || c === null ? "missing" : "other",
        balanceNumeric: typeof b === "number" && Number.isFinite(b), balanceNonNegative: typeof b === "number" && b >= 0 };
      out.legacyUsdWalletReader = c === "usd" && typeof b === "number" && Number.isFinite(b);
      out.sealed = { billingType: typeof d?.billing_type === "string" ? d.billing_type.slice(0, 40) : null, currency: typeof c === "string" ? c.slice(0, 20) : null, balance: typeof b === "number" ? b : null };
    }
  } catch { out.usersMe.transportError = true; }
  return out;
}

export async function providerConfigReport(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Promise<ProviderConfigReport> {
  const raw = env.ELEVENLABS_API_KEY;
  const elevenlabsKey = raw === undefined ? "missing" : raw.trim() ? "present" : "blank";
  let voices: ProviderConfigReport["voices"];
  try {
    const list = await listAccountVoices({ env, fetchImpl, fresh: true });
    const user = list.find((v) => v.name.trim().toLowerCase() === "atomivid 2485ab5a");
    voices = { ok: true, count: list.length, hansPodcast: list.some((v) => /hans\s*podcast/i.test(v.name)), userVoice: { found: !!user, category: user?.category ?? null } };
  } catch (e) {
    voices = { ok: false, error: e instanceof VoicesUnavailableError ? e.customerMessage : "error" };
  }
  const state = (k: string) => (env[k] === undefined ? "missing" : env[k]!.trim() ? "present" : "blank") as "present" | "blank" | "missing";
  const keys = Object.fromEntries(["ELEVENLABS_API_KEY", "HEYGEN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RUNWAY_API_KEY", "PEXELS_API_KEY", "GH_WORKER_TOKEN", "GH_WORKER_REPO", "SUPABASE_SERVICE_ROLE_KEY",
    // Long Form 15-min readiness (2026-10-23): presence only — Recraft balance refresh and voice selection flags.
    "FAL_KEY", "FAL_ADMIN_KEY", "REEL_VOICE_SELECTION_ENABLED", "RECRAFT_REEL_ENABLED", "RECRAFT_PILOT_OWNER_USER_ID", "INTERNAL_PRODUCTION_OWNER_USER_ID", "ELEVENLABS_VOICE_ID", "ELEVENLABS_VOICE_ID_EN", "PRIVATE_VOICE_GRANTS"].map((k) => [k, state(k)]));
  return { keys, vercelEnv: env.VERCEL_ENV ?? null, commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, elevenlabsKey,
    elevenEnvNames: Object.keys(env).filter((k) => /ELEVEN|HEYGEN/i.test(k)).sort(), voices, heygen: await heygenProbe(env, fetchImpl) };
}

/**
 * The start click's own admission for the newest avatar request still waiting at review (status
 * script_ready, never started): same demands and readiness rule as the render route, with the
 * just-in-time balance refresh (billing GET only). Nothing is reserved, queued or generated.
 * Public: verdict/reason. `sealed`: amounts and the user-facing action text.
 */
export type AvatarReadinessProbe = {
  found: boolean;
  avatarProvider: string;
  demand: { provider: string; unit: string }[];
  ready: boolean | null;
  providers: { provider: string; level: string | null; refreshed: boolean; verdict: string; failure: string | null }[];
  sealed: { capUsd: number; providers: { provider: string; free: number | null; units: number | null; usd: number; action: string | null }[] } | null;
};

export async function avatarReadinessProbe(): Promise<AvatarReadinessProbe> {
  const { createServiceClient } = await import("@/lib/supabase/service");
  const { jobSupplyDemands } = await import("@/lib/supply/job");
  const { ensureJobSupplyReady } = await import("@/lib/supply/readiness");
  const { providerCheck } = await import("@/lib/video/long-form/production-preflight");
  const { getFeatureFlags } = await import("@/lib/video/feature-flags");
  const { getVoiceProvider } = await import("@/lib/providers/voice");
  const flags = getFeatureFlags();
  const service = createServiceClient();
  const { data } = await service.from("video_requests").select("id,mode,script_json,recorded_audio_path,long_form_production_plan,status,render_attempts")
    .eq("mode", "avatar").eq("status", "script_ready").eq("render_attempts", 0).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const out: AvatarReadinessProbe = { found: !!data, avatarProvider: flags.avatarProvider, demand: [], ready: null, providers: [], sealed: null };
  if (!data) return out;
  let voice = "unconfigured";
  try { voice = getVoiceProvider().name; } catch { /* recorded audio needs no voice */ }
  const demands = jobSupplyDemands(data as never, voice, flags);
  out.demand = demands.map((d) => ({ provider: d.provider, unit: d.unit }));
  const r = await ensureJobSupplyReady(service, demands);
  out.ready = r.ready;
  const checks = r.providers.map((p) => ({ p, c: providerCheck(p, demands.find((d) => d.provider === p.provider)?.unit ?? "usd") }));
  out.providers = checks.map(({ p, c }) => ({ provider: p.provider, level: p.level, refreshed: p.refreshed, verdict: c.verdict, failure: p.failure ?? null }));
  out.sealed = { capUsd: flags.maxAvatarCostUsd, providers: checks.map(({ p, c }) => ({ provider: p.provider, free: p.free, units: p.units, usd: p.usd, action: c.action })) };
  return out;
}

/**
 * Reconciliation evidence for an uncertain HeyGen generate_video (status RECONCILIATION_REQUIRED):
 * read-only GET /v3/videos (cursor pagination). GET /v1/video.list is legacy and retires 2026-11-01
 * (https://developers.heygen.com/endpoint-version-comparison). Ids are hashed; only counts, statuses
 * and times leave the runtime. Nothing is created or charged. A legacy envelope or a truncated page
 * is a failure, never an empty account.
 */
export type HeygenListFailure = "unauthorized" | "rate_limited" | "legacy_envelope" | "incomplete" | "transport";

export type HeygenListedVideo = { id: string; status: string | null; createdAtSec: number | null };

export type HeygenReconcileProbe = {
  http: number | null;
  pages: number;
  /** Coverage proof: total listed and the oldest listed time. Incomplete coverage sets `failure`. */
  listed: number;
  oldestListedAt: string | null;
  contract: "v3" | "unreached";
  failure: HeygenListFailure | null;
  uncertain: { opCreatedAt: string; windowVideos: { id: string; status: string | null; createdAt: string | null }[]; committedJobInWindow: boolean; committedJobInList: boolean; committedJob: string | null }[];
};

/** Official list body is `{ data: VideoDetail[], has_more, next_token }`. `id`, not `video_id`. */
export function parseHeygenVideoListBody(body: unknown):
  | { ok: true; videos: HeygenListedVideo[]; nextToken: string | null; hasMore: boolean }
  | { ok: false; failure: "legacy_envelope" | "incomplete" } {
  if (!body || typeof body !== "object") return { ok: false, failure: "incomplete" };
  const root = body as Record<string, unknown>;
  const warning = root.warning;
  if (warning && typeof warning === "object" && typeof (warning as { v3_endpoint?: unknown }).v3_endpoint === "string") {
    return { ok: false, failure: "legacy_envelope" };
  }
  const data = root.data;
  if (data && typeof data === "object" && !Array.isArray(data) && ("videos" in data || "token" in (data as object))) {
    return { ok: false, failure: "legacy_envelope" };
  }
  if (!Array.isArray(data)) return { ok: false, failure: "incomplete" };
  const videos: HeygenListedVideo[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") return { ok: false, failure: "incomplete" };
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || typeof row.status !== "string") return { ok: false, failure: "incomplete" };
    if (row.created_at != null && (typeof row.created_at !== "number" || !Number.isFinite(row.created_at))) return { ok: false, failure: "incomplete" };
    videos.push({ id: row.id, status: row.status, createdAtSec: typeof row.created_at === "number" ? row.created_at : null });
  }
  if (root.next_token != null && typeof root.next_token !== "string") return { ok: false, failure: "incomplete" };
  if (root.has_more != null && typeof root.has_more !== "boolean") return { ok: false, failure: "incomplete" };
  const nextToken = typeof root.next_token === "string" && root.next_token ? root.next_token : null;
  return { ok: true, videos, nextToken, hasMore: root.has_more === true };
}

export async function readHeygenVideoList(fetchImpl: typeof fetch, key: string): Promise<{
  http: number | null; pages: number; videos: HeygenListedVideo[]; failure: HeygenListFailure | null; oldestListedAt: string | null;
}> {
  const videos: HeygenListedVideo[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  let http: number | null = null;
  let pages = 0;
  let failure: HeygenListFailure | null = null;
  let rateWaits = 0;
  for (let page = 0; page < 20;) {
    const url = `https://api.heygen.com/v3/videos?limit=100${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { "X-Api-Key": key }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    } catch {
      failure = "transport";
      break;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      http = 429;
      if (rateWaits >= 2) { failure = "rate_limited"; break; }
      rateWaits += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, Number.isFinite(retryAfter) ? retryAfter * 1000 : 250))));
      continue;
    }
    http = response.status;
    if (response.status === 401 || response.status === 403) { failure = "unauthorized"; break; }
    if (!response.ok) { failure = "incomplete"; break; }
    const parsed = parseHeygenVideoListBody(await response.json().catch(() => null));
    if (!parsed.ok) { failure = parsed.failure; break; }
    pages += 1;
    page += 1;
    videos.push(...parsed.videos);
    if (!parsed.hasMore) { failure = null; break; }
    if (!parsed.nextToken || seen.has(parsed.nextToken)) { failure = "incomplete"; break; }
    seen.add(parsed.nextToken);
    token = parsed.nextToken;
    if (page >= 20) failure = "incomplete";
  }
  const oldest = Math.min(...videos.map((v) => (v.createdAtSec ?? Infinity) * 1000));
  return { http, pages, videos, failure, oldestListedAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null };
}

const h10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

export async function heygenReconcileProbe(fetchImpl: typeof fetch = fetch): Promise<HeygenReconcileProbe | null> {
  const key = process.env.HEYGEN_API_KEY?.trim();
  if (!key || /[•●*]/.test(key)) return null;
  const { createServiceClient } = await import("@/lib/supabase/service");
  const service = createServiceClient();
  const { data: ops } = await service.from("pi_paid_operations").select("project_id,created_at,updated_at").eq("provider", "heygen").eq("method", "generate_video").eq("status", "RECONCILIATION_REQUIRED");
  const out: HeygenReconcileProbe = { http: null, pages: 0, listed: 0, oldestListedAt: null, contract: "unreached", failure: null, uncertain: [] };
  if (!ops?.length) return out;
  const listed = await readHeygenVideoList(fetchImpl, key);
  out.http = listed.http;
  out.pages = listed.pages;
  out.listed = listed.videos.length;
  out.oldestListedAt = listed.oldestListedAt;
  out.failure = listed.failure;
  out.contract = listed.failure === "legacy_envelope" || listed.pages === 0 ? "unreached" : "v3";
  if (listed.failure) return out;
  for (const o of ops) {
    const t = Date.parse(o.created_at);
    // Same project's committed job (the later successful retry), to tell it apart from an extra video.
    const { data: sib } = await service.from("pi_paid_operations").select("provider_job_id").eq("project_id", o.project_id).eq("provider", "heygen").eq("status", "COMMITTED").maybeSingle();
    const committed = sib?.provider_job_id ? String(sib.provider_job_id) : null;
    const win = listed.videos.filter((v) => v.createdAtSec && v.createdAtSec * 1000 >= t - 120_000 && v.createdAtSec * 1000 <= t + 3_600_000);
    out.uncertain.push({ opCreatedAt: o.created_at, committedJob: committed ? h10(committed) : null, committedJobInWindow: !!committed && win.some((v) => v.id === committed), committedJobInList: !!committed && listed.videos.some((v) => v.id === committed),
      windowVideos: win.map((v) => ({ id: h10(v.id), status: v.status, createdAt: v.createdAtSec ? new Date(v.createdAtSec * 1000).toISOString() : null })) });
  }
  return out;
}
