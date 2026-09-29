/**
 * youtube:doctor — deterministic, read-only diagnosis of the YouTube monitoring go-live state.
 * Every check reports presence/validity only; secret VALUES never enter the result (guarded by
 * containsSecretValue on the whole output). Dependencies are injected so tests run offline.
 */
import { scopesFor } from "./capabilities";
import { distributionFlags } from "./capabilities";
import { GOOGLE_TOKEN_URL, accessToken, oauthConfig } from "./oauth";
import { channelQuery, DATA_CHANNELS_URL } from "./channel-snapshot";
import { ANALYTICS_REPORTS_URL, DATA_VIDEOS_URL } from "./analytics";
import { finalCutFlags } from "@/lib/final-cut/gate";
import { containsSecretValue } from "@/lib/production-intelligence/capacity/accounts";
import type { YouTubeStore } from "./store";

export const DOCTOR_STATUSES = ["READY", "BLOCKED_EXTERNAL", "BLOCKED_CONFIG", "BLOCKED_DATABASE", "BLOCKED_AUTH", "ERROR"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];
export type CheckState = "OK" | "FAIL" | "UNKNOWN" | "SKIPPED";
export type Check = { id: string; label: string; state: CheckState; blocks: DoctorStatus | null; detail: string };

export const REQUIRED_MIGRATIONS = ["0024_distribution_youtube.sql", "0026_youtube_read_only_monitoring.sql", "0027_final_cut_intelligence.sql", "0028_youtube_go_live.sql"] as const;
const READ_SCOPES = scopesFor(["READ_CHANNEL", "READ_ANALYTICS"]);

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type DoctorDeps = {
  env: Record<string, string | undefined>;
  /** Migration file names present in the repo (supabase/migrations). */
  migrationFilesPresent: string[];
  /** Names registered in public._migrations_applied, or null when the database is unreachable. */
  migrationsApplied: (() => Promise<string[] | null>) | null;
  /** Network probe; null = offline (reachability checks become UNKNOWN). */
  fetch: Fetch | null;
  store: YouTubeStore | null;
  connectionId: string | null;
  now: string;
};

export type DoctorReport = { status: DoctorStatus; checks: Check[]; summary: string; ranAt: string };

const ok = (id: string, label: string, detail: string): Check => ({ id, label, state: "OK", blocks: null, detail });
const fail = (id: string, label: string, blocks: DoctorStatus, detail: string): Check => ({ id, label, state: "FAIL", blocks, detail });
const unknown = (id: string, label: string, blocks: DoctorStatus | null, detail: string): Check => ({ id, label, state: "UNKNOWN", blocks, detail });
const skipped = (id: string, label: string, detail: string): Check => ({ id, label, state: "SKIPPED", blocks: null, detail });

export async function youtubeDoctor(d: DoctorDeps): Promise<DoctorReport> {
  const c: Check[] = [];
  const env = d.env;
  // ---- configuration (presence + shape only) ----
  c.push(env.GOOGLE_OAUTH_CLIENT_ID ? (/\.apps\.googleusercontent\.com$/.test(env.GOOGLE_OAUTH_CLIENT_ID) ? ok("oauth_client", "OAuth client configured", "client id present with the Google client-id shape") : fail("oauth_client", "OAuth client configured", "BLOCKED_CONFIG", "GOOGLE_OAUTH_CLIENT_ID does not look like a Google OAuth client id")) : fail("oauth_client", "OAuth client configured", "BLOCKED_CONFIG", "GOOGLE_OAUTH_CLIENT_ID missing"));
  c.push(env.GOOGLE_OAUTH_CLIENT_SECRET ? ok("oauth_secret", "OAuth secret configured", `present (${env.GOOGLE_OAUTH_CLIENT_SECRET.length} chars)`) : fail("oauth_secret", "OAuth secret configured", "BLOCKED_CONFIG", "GOOGLE_OAUTH_CLIENT_SECRET missing"));
  const keyBytes = env.YOUTUBE_TOKEN_ENC_KEY ? Buffer.from(env.YOUTUBE_TOKEN_ENC_KEY, "base64").length : 0;
  c.push(keyBytes === 32 ? ok("enc_key", "Encryption key configured", "32-byte AES-256-GCM key present") : fail("enc_key", "Encryption key configured", "BLOCKED_CONFIG", env.YOUTUBE_TOKEN_ENC_KEY ? `key decodes to ${keyBytes} bytes, need 32` : "YOUTUBE_TOKEN_ENC_KEY missing"));
  const redirect = env.GOOGLE_OAUTH_REDIRECT_URI;
  let redirectOk = false;
  try { const u = new URL(redirect ?? ""); redirectOk = (u.protocol === "https:" || u.hostname === "localhost") && u.pathname.endsWith("/api/distribution/youtube/callback"); } catch { redirectOk = false; }
  c.push(redirectOk ? ok("redirect", "Redirect URI configured/valid", "https callback on /api/distribution/youtube/callback") : fail("redirect", "Redirect URI configured/valid", "BLOCKED_CONFIG", redirect ? "must be https and end with /api/distribution/youtube/callback" : "GOOGLE_OAUTH_REDIRECT_URI missing"));
  // ---- migrations ----
  const missingFiles = REQUIRED_MIGRATIONS.filter((m) => !d.migrationFilesPresent.includes(m));
  c.push(missingFiles.length ? fail("migrations_present", "Required migrations present", "ERROR", `missing files: ${missingFiles.join(", ")}`) : ok("migrations_present", "Required migrations present", REQUIRED_MIGRATIONS.join(", ")));
  if (!d.migrationsApplied) c.push(unknown("migrations_applied", "Required migrations applied", "BLOCKED_DATABASE", "no database probe available"));
  else {
    let applied: string[] | null = null;
    try { applied = await d.migrationsApplied(); } catch { applied = null; }
    if (applied === null) c.push(unknown("migrations_applied", "Required migrations applied", "BLOCKED_DATABASE", "database unreachable"));
    else { const notApplied = REQUIRED_MIGRATIONS.filter((m) => !applied!.includes(m)); c.push(notApplied.length ? fail("migrations_applied", "Required migrations applied", "BLOCKED_DATABASE", `not applied: ${notApplied.join(", ")} (needs explicit authorization)`) : ok("migrations_applied", "Required migrations applied", "all registered in _migrations_applied")); }
  }
  // ---- API reachability (unauthenticated GET: any HTTP answer proves the host is reachable) ----
  const probe = async (id: string, label: string, url: string) => {
    if (!d.fetch) { c.push(unknown(id, label, "BLOCKED_EXTERNAL", "offline: no network probe")); return; }
    try { const r = await d.fetch(url); c.push(r.status >= 500 ? fail(id, label, "BLOCKED_EXTERNAL", `HTTP ${r.status}`) : ok(id, label, `reachable (HTTP ${r.status} without credentials)`)); } catch (e) { c.push(fail(id, label, "BLOCKED_EXTERNAL", `unreachable: ${(e as Error).message}`)); }
  };
  await probe("data_api", "YouTube Data API reachable", `${DATA_VIDEOS_URL}?part=id&id=doctor`);
  await probe("analytics_api", "YouTube Analytics API reachable", `${ANALYTICS_REPORTS_URL}?ids=channel%3D%3DMINE&startDate=2026-01-01&endDate=2026-01-02&metrics=views`);
  // When Google itself is unreachable, a failed refresh is an outage, not an auth problem.
  const apiReachable = c.filter((x) => x.id === "data_api" || x.id === "analytics_api").every((x) => x.state === "OK");
  // ---- connection / auth ----
  const conn = d.store && d.connectionId ? await d.store.getConnection(d.connectionId).catch(() => null) : null;
  if (!d.store) c.push(unknown("connection", "Connection exists", "BLOCKED_DATABASE", "no store"));
  else if (!d.connectionId) c.push(fail("connection", "Connection exists", "BLOCKED_AUTH", "no connectionId: the channel has not been connected yet"));
  else if (!conn) c.push(fail("connection", "Connection exists", "BLOCKED_AUTH", "connection not found or revoked"));
  else c.push(ok("connection", "Connection exists", `connection ${d.connectionId} stored with ${conn.scopes.length} scope(s)`));
  if (conn) {
    const extra = conn.scopes.filter((s) => !READ_SCOPES.includes(s)), missing = READ_SCOPES.filter((s) => !conn.scopes.includes(s));
    c.push(extra.length ? fail("scopes", "Scopes are read-only", "BLOCKED_AUTH", `non-read scopes granted: ${extra.join(", ")}`) : missing.length ? fail("scopes", "Scopes are read-only", "BLOCKED_AUTH", `missing read scopes: ${missing.join(", ")}`) : ok("scopes", "Scopes are read-only", READ_SCOPES.join(" ")));
    c.push(conn.refreshTokenEnc.startsWith("v1.") ? ok("token_valid", "Token valid", "encrypted refresh-token envelope present (v1)") : fail("token_valid", "Token valid", "BLOCKED_AUTH", "stored token is not a v1 envelope"));
    if (!d.fetch || !apiReachable || !redirectOk || keyBytes !== 32 || !env.GOOGLE_OAUTH_CLIENT_SECRET) { c.push(skipped("refresh", "Refresh token works", d.fetch && !apiReachable ? "skipped: Google APIs unreachable (see reachability checks)" : "skipped: offline or configuration incomplete")); c.push(skipped("channel", "Channel accessible", "skipped")); }
    else {
      let token: string | null = null;
      try { token = await accessToken(d.fetch, oauthConfig(env), env, conn.refreshTokenEnc); c.push(ok("refresh", "Refresh token works", `access token obtained from ${GOOGLE_TOKEN_URL} (not shown)`)); }
      catch (e) { c.push(fail("refresh", "Refresh token works", "BLOCKED_AUTH", (e as Error).message.replace(/ya29\.[\w-]+/g, "<token>"))); }
      if (token) {
        try { const r = await d.fetch(channelQuery(), { headers: { Authorization: `Bearer ${token}` } }); const j = r.ok ? ((await r.json()) as { items?: { id: string }[] }) : null; c.push(j?.items?.length ? ok("channel", "Channel accessible", `channels.list returned ${j.items[0].id}`) : fail("channel", "Channel accessible", r.status === 403 || r.status === 429 ? "BLOCKED_EXTERNAL" : "BLOCKED_AUTH", `${DATA_CHANNELS_URL} HTTP ${r.status}`)); }
        catch (e) { c.push(fail("channel", "Channel accessible", "BLOCKED_EXTERNAL", (e as Error).message)); }
      } else c.push(skipped("channel", "Channel accessible", "skipped: no access token"));
    }
  } else { for (const [id, label] of [["scopes", "Scopes are read-only"], ["token_valid", "Token valid"], ["refresh", "Refresh token works"], ["channel", "Channel accessible"]] as const) c.push(skipped(id, label, "skipped: no connection")); }
  // ---- policy ----
  const flags = distributionFlags(env);
  c.push(flags.AUTO_PUBLISH === false && !flags.enabled.includes("UPLOAD_PRIVATE") ? ok("auto_publish", "AUTO_PUBLISH disabled", "AUTO_PUBLISH=false; upload capability off") : fail("auto_publish", "AUTO_PUBLISH disabled", "ERROR", "publishing/upload capability is enabled"));
  c.push(finalCutFlags(env).enabled ? ok("final_cut_gate", "Final Cut distribution gate active", "FINAL_CUT_ENABLED != false") : fail("final_cut_gate", "Final Cut distribution gate active", "ERROR", "FINAL_CUT_ENABLED=false: masters would reach distribution without EDITORIAL_QA_PASS"));

  // ---- verdict: the most severe blocker wins (ERROR > DATABASE > CONFIG > AUTH > EXTERNAL) ----
  const order: DoctorStatus[] = ["ERROR", "BLOCKED_DATABASE", "BLOCKED_CONFIG", "BLOCKED_AUTH", "BLOCKED_EXTERNAL"];
  const blockers = c.filter((x) => x.blocks && (x.state === "FAIL" || x.state === "UNKNOWN")).map((x) => x.blocks!);
  const status: DoctorStatus = blockers.length ? order.find((s) => blockers.includes(s))! : "READY";
  const report: DoctorReport = { status, checks: c, summary: `${c.filter((x) => x.state === "OK").length} OK, ${c.filter((x) => x.state === "FAIL").length} FAIL, ${c.filter((x) => x.state === "UNKNOWN").length} UNKNOWN, ${c.filter((x) => x.state === "SKIPPED").length} SKIPPED -> ${status}`, ranAt: d.now };
  if (containsSecretValue(report)) throw new Error("doctor report would contain a secret value; refusing to return it");
  return report;
}
