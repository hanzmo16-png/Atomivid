/**
 * Server-side OAuth foundation (Google official endpoints). Tokens never reach the
 * browser: the refresh token is encrypted with AES-256-GCM using YOUTUBE_TOKEN_ENC_KEY
 * (32 bytes, base64) before storage. No client secret lives in code: it is read from
 * GOOGLE_OAUTH_CLIENT_SECRET at runtime. Nothing here runs a real OAuth flow in V1 tests.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { scopesFor, type Capability } from "./capabilities";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type OAuthConfig = { clientId: string; redirectUri: string };

export class OAuthConfigError extends Error {}

export function oauthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID, redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new OAuthConfigError("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI are required");
  return { clientId, redirectUri };
}

/** PKCE + state; `state` binds the callback to one user/channel connection attempt. */
export function buildAuthorizationUrl(cfg: OAuthConfig, caps: Capability[], state: string): { url: string; codeVerifier: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: scopesFor(caps).join(" "),
    // No incremental authorization: previously granted scopes (possibly write-capable) must never be merged into this token.
    access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
  });
  return { url: `${GOOGLE_AUTH_URL}?${q}`, codeVerifier };
}

export function encryptToken(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new OAuthConfigError("YOUTUBE_TOKEN_ENC_KEY must be 32 bytes (base64)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptToken(blob: string, keyB64: string): string {
  const [v, iv, tag, enc] = blob.split(".");
  if (v !== "v1") throw new OAuthConfigError("Unknown token envelope");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Exchange an authorization code (server-side only). Returns the encrypted refresh token and granted scopes. */
export async function exchangeCode(fetchImpl: Fetch, cfg: OAuthConfig, env: Record<string, string | undefined>, code: string, codeVerifier: string): Promise<{ refreshTokenEnc: string; scopes: string[] }> {
  const secret = env.GOOGLE_OAUTH_CLIENT_SECRET, key = env.YOUTUBE_TOKEN_ENC_KEY;
  if (!secret || !key) throw new OAuthConfigError("GOOGLE_OAUTH_CLIENT_SECRET and YOUTUBE_TOKEN_ENC_KEY are required");
  const r = await fetchImpl(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: secret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier }).toString() });
  if (!r.ok) throw new OAuthConfigError(`Token exchange failed HTTP ${r.status}`);
  const j = (await r.json()) as { refresh_token?: string; scope?: string };
  if (!j.refresh_token) throw new OAuthConfigError("No refresh token returned (consent must request offline access)");
  return { refreshTokenEnc: encryptToken(j.refresh_token, key), scopes: (j.scope ?? "").split(" ").filter(Boolean).sort() };
}

/** Short-lived access token from the stored refresh token; never persisted. */
export async function accessToken(fetchImpl: Fetch, cfg: OAuthConfig, env: Record<string, string | undefined>, refreshTokenEnc: string): Promise<string> {
  const secret = env.GOOGLE_OAUTH_CLIENT_SECRET, key = env.YOUTUBE_TOKEN_ENC_KEY;
  if (!secret || !key) throw new OAuthConfigError("OAuth secrets missing");
  const r = await fetchImpl(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: secret, refresh_token: decryptToken(refreshTokenEnc, key), grant_type: "refresh_token" }).toString() });
  if (!r.ok) throw new OAuthConfigError(`Refresh failed HTTP ${r.status} (revoked or expired: reconnect the channel)`);
  return ((await r.json()) as { access_token: string }).access_token;
}

/** Disconnect: revoke at Google, then the caller deletes the stored envelope. */
export async function revoke(fetchImpl: Fetch, env: Record<string, string | undefined>, refreshTokenEnc: string): Promise<boolean> {
  const key = env.YOUTUBE_TOKEN_ENC_KEY;
  if (!key) throw new OAuthConfigError("YOUTUBE_TOKEN_ENC_KEY missing");
  const r = await fetchImpl(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: decryptToken(refreshTokenEnc, key) }).toString() });
  return r.ok;
}
