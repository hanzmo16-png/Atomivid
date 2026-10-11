/**
 * «Conectar Google Drive» from the web (owner only). It replaces the copy-by-hand steps of the Actions flow:
 *  1. start: a fresh attempt (random state + PKCE verifier, google-oauth.ts) sealed with AES-256-GCM into an httpOnly
 *     cookie that lives 15 minutes; the browser goes to Google's consent page (full drive scope, offline).
 *  2. callback: the state must match the cookie (CSRF), the code is exchanged server side, the grant must carry the
 *     full drive scope AND the account must own the coordination folder and be able to write in it (drive-check.ts).
 *     Only then the refresh token is stored, encrypted (same envelope as the YouTube connection), in the private
 *     "videos" bucket, readable with the service role only. Otherwise nothing is kept.
 *  3. GitHub Actions never receives the refresh token: the orchestrator asks /api/orchestrator/drive/token with a
 *     GitHub OIDC token (github-oidc.ts) and gets a Drive access token that expires within the hour.
 * Nothing here returns or logs a token to the browser. All I/O is injected (FakeDrive in tests).
 */
import { decryptToken, encryptToken } from "@/lib/distribution/youtube/oauth";
import { checkDriveConnection, type DriveCheckResult, type DriveTarget } from "./drive-check";
import { checkTokenResponse, consentUrl, newPending, parsePending, tokenRequestBody, DRIVE_SCOPE, type Pending } from "./google-oauth";

export const PENDING_COOKIE = "atv_drive_oauth";
export const CALLBACK_PATH = "/api/orchestrator/drive/callback";
export const CONNECTION_OBJECT = { bucket: "videos", path: "orchestrator/drive-connection.v1.json" } as const;
/** The coordination folders (non-secret ids, same as the workflows). */
export const COORDINATION: DriveTarget = { root: "17GzExKZIgjOTF1Ods0H1AapuRssQ9m8Z", solicitudes: "1WJ4FpKjMvOpn60i3diyy7sL7uDQfZp9W", entregas: "1z8C1ZnE8rh9iUUiEYQrNU-x7VMzCI4SJ" };

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type DriveWebConfig = { clientId: string; clientSecret: string; redirectUri: string; key: string };
export type StoredDriveConnection = { v: 1; refreshTokenEnc: string; scope: string; connectedAt: string };
export interface DriveConnectionStore { get(): Promise<StoredDriveConnection | null>; put(c: StoredDriveConnection): Promise<void> }

export class DriveConnectError extends Error { constructor(readonly code: string, message: string) { super(message); } }

/**
 * A "Web application" OAuth client (a Desktop client cannot use an https callback). DRIVE_OAUTH_* first; otherwise the
 * web client already configured for YouTube (GOOGLE_OAUTH_*), with this callback added to its redirect URIs.
 * Errors name the missing variable, never a value.
 */
export function driveWebConfig(env: Env): DriveWebConfig {
  const clientId = env.DRIVE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = env.DRIVE_OAUTH_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = env.DRIVE_OAUTH_REDIRECT_URI, key = env.DRIVE_TOKEN_ENC_KEY || env.YOUTUBE_TOKEN_ENC_KEY;
  if (!clientId || !clientSecret) throw new DriveConnectError("config", "faltan DRIVE_OAUTH_CLIENT_ID/DRIVE_OAUTH_CLIENT_SECRET (o el cliente web GOOGLE_OAUTH_*)");
  if (!redirectUri) throw new DriveConnectError("config", "falta DRIVE_OAUTH_REDIRECT_URI");
  let u: URL;
  try { u = new URL(redirectUri); } catch { throw new DriveConnectError("config", "DRIVE_OAUTH_REDIRECT_URI no es una URL"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if ((u.protocol !== "https:" && !(local && u.protocol === "http:")) || u.pathname !== CALLBACK_PATH || u.search || u.hash) throw new DriveConnectError("config", `DRIVE_OAUTH_REDIRECT_URI debe ser https://<dominio>${CALLBACK_PATH}`);
  if (!key || Buffer.from(key, "base64").length !== 32) throw new DriveConnectError("config", "falta DRIVE_TOKEN_ENC_KEY (o YOUTUBE_TOKEN_ENC_KEY) de 32 bytes en base64");
  return { clientId, clientSecret, redirectUri, key };
}

/** Step 1: consent URL + sealed cookie value. */
export function startDriveConnect(cfg: DriveWebConfig, now = new Date()): { url: string; cookie: string } {
  const pending = newPending(now);
  return { url: consentUrl(cfg.clientId, pending, cfg.redirectUri), cookie: encryptToken(JSON.stringify(pending), cfg.key) };
}

function openCookie(cookie: string | undefined, key: string, now: number): Pending {
  let raw: string | undefined;
  try { raw = cookie ? decryptToken(cookie, key) : undefined; } catch { raw = undefined; }
  const p = parsePending(raw, now);
  if (!p.ok) throw new DriveConnectError("expired", "el intento caducó o no es de este navegador: pulsa «Conectar Google Drive» otra vez");
  return p.pending;
}

export type ConnectOutcome = { connectedAt: string; checks: DriveCheckResult["checks"]; counts: DriveCheckResult["counts"] };

/** Step 2: Google's redirect (query string) + the cookie. Stores the connection only after the real Drive check. */
export async function completeDriveConnect(deps: { cfg: DriveWebConfig; store: DriveConnectionStore; fetch: FetchLike; now?: Date; target?: DriveTarget },
  query: URLSearchParams, cookie: string | undefined): Promise<ConnectOutcome> {
  const now = deps.now ?? new Date();
  const pending = openCookie(cookie, deps.cfg.key, now.getTime());
  if (query.get("error")) throw new DriveConnectError("denied", "se canceló el consentimiento en Google");
  if (query.get("state") !== pending.state) throw new DriveConnectError("state", "la respuesta de Google no corresponde a este intento");
  const code = query.get("code") ?? "";
  if (!/^[A-Za-z0-9/_.-]{10,512}$/.test(code)) throw new DriveConnectError("code", "falta el código de autorización");
  const r = await deps.fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody({ code, verifier: pending.verifier, clientId: deps.cfg.clientId, clientSecret: deps.cfg.clientSecret, redirectUri: deps.cfg.redirectUri }) }).catch(() => null);
  const body = r ? ((await r.json().catch(() => null)) as { refresh_token?: string; scope?: string; error?: string } | null) : null;
  const tok = checkTokenResponse(r?.status ?? 0, body);
  if (!tok.ok) throw new DriveConnectError("exchange", tok.reason);
  const creds = { clientId: deps.cfg.clientId, clientSecret: deps.cfg.clientSecret, refreshToken: tok.refreshToken };
  const check = await checkDriveConnection(creds, deps.target ?? COORDINATION, deps.fetch);
  // Not revoked on failure: a network error would make the owner's own valid grant look like another account's.
  // The token is simply discarded (never stored, never returned).
  if (!check.ok) throw new DriveConnectError("check", check.reason ?? "la conexión con Drive no pasó la comprobación");
  const connectedAt = now.toISOString();
  // Same account reconnecting: overwriting is enough (revoking the old token would revoke the whole grant, new one included).
  await deps.store.put({ v: 1, refreshTokenEnc: encryptToken(tok.refreshToken, deps.cfg.key), scope: DRIVE_SCOPE, connectedAt });
  return { connectedAt, checks: check.checks, counts: check.counts };
}

/** Step 3: a Drive access token for an authenticated orchestrator job (the caller verified the OIDC token). */
export async function mintDriveAccessToken(deps: { cfg: Pick<DriveWebConfig, "clientId" | "clientSecret" | "key">; store: DriveConnectionStore; fetch: FetchLike }): Promise<{ access_token: string; expires_in: number; scope: string }> {
  const c = await deps.store.get();
  if (!c) throw new DriveConnectError("not-connected", "Google Drive no está conectado: usa «Conectar Google Drive» en el Centro de mando");
  const r = await deps.fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptToken(c.refreshTokenEnc, deps.cfg.key), client_id: deps.cfg.clientId, client_secret: deps.cfg.clientSecret }).toString() }).catch(() => null);
  const j = r && r.ok ? ((await r.json().catch(() => null)) as { access_token?: string; expires_in?: number; scope?: string } | null) : null;
  if (!j?.access_token) throw new DriveConnectError("refresh", "la conexión con Drive dejó de funcionar (revocada o caducada): vuelve a conectar Google Drive");
  // Never more than an hour, whatever Google answers.
  return { access_token: j.access_token, expires_in: Math.min(3600, Math.max(60, Number(j.expires_in) || 3600)), scope: j.scope ?? "" };
}

/** Owner-facing status: connected or not, and since when. Never the token. */
export async function driveConnectionStatus(store: DriveConnectionStore): Promise<{ connected: boolean; connectedAt: string | null }> {
  const c = await store.get().catch(() => null);
  return { connected: !!c, connectedAt: c?.connectedAt ?? null };
}

export function memoryDriveConnectionStore(): DriveConnectionStore & { value: StoredDriveConnection | null } {
  const s = { value: null as StoredDriveConnection | null, async get() { return s.value; }, async put(c: StoredDriveConnection) { s.value = c; } };
  return s;
}

type StorageLike = { storage: { from(bucket: string): {
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
  upload(path: string, body: Blob | string, opts: { contentType: string; upsert: boolean }): Promise<{ error: { message: string } | null }>;
} } };

/** Private bucket, service role only (no storage policy for anon/authenticated on "videos" since migration 0006). */
export function supabaseDriveConnectionStore(sb: StorageLike): DriveConnectionStore {
  const bucket = () => sb.storage.from(CONNECTION_OBJECT.bucket);
  return {
    async get() {
      const { data, error } = await bucket().download(CONNECTION_OBJECT.path);
      if (error || !data) return null;
      const j = JSON.parse(await data.text()) as Partial<StoredDriveConnection>;
      return j.v === 1 && typeof j.refreshTokenEnc === "string" && typeof j.connectedAt === "string" ? (j as StoredDriveConnection) : null;
    },
    async put(c) {
      const { error } = await bucket().upload(CONNECTION_OBJECT.path, new Blob([JSON.stringify(c)], { type: "application/json" }), { contentType: "application/json", upsert: true });
      if (error) throw new DriveConnectError("store", "no se pudo guardar la conexión");
    },
  };
}
