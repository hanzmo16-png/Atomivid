/**
 * Server-side connect flow (READ scopes only) over the existing OAuth foundation:
 * start -> Google consent URL (PKCE + state persisted server side) ->
 * complete -> code exchange, encrypted refresh token stored, channel row created.
 * The plaintext refresh token never leaves this module; responses carry no token.
 */
import { randomBytes } from "node:crypto";
import { buildAuthorizationUrl, exchangeCode, accessToken, oauthConfig, OAuthConfigError } from "./oauth";
import { distributionFlags, scopesFor, type Capability } from "./capabilities";
import { ChannelSchema, type Channel } from "./channels";
import { channelQuery, type ChannelListResponse } from "./oauth-channel-query";
import type { YouTubeOAuthStore } from "./oauth-store";

type Env = Record<string, string | undefined>;
type Fetch = Parameters<typeof exchangeCode>[0] & ((url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>);

const READ_CAPS: Capability[] = ["READ_CHANNEL", "READ_ANALYTICS"];

export async function startConnect(deps: { store: YouTubeOAuthStore; env: Env; now: string }, ownerUserId: string): Promise<{ url: string; connectionId: string }> {
  const flags = distributionFlags(deps.env);
  const caps = READ_CAPS.filter((c) => flags.enabled.includes(c));
  if (caps.length !== READ_CAPS.length) throw new OAuthConfigError("read capabilities are not enabled");
  const cfg = oauthConfig(deps.env);
  const state = randomBytes(24).toString("base64url");
  const connectionId = "ytc_" + randomBytes(12).toString("base64url");
  const { url, codeVerifier } = buildAuthorizationUrl(cfg, caps, state);
  await deps.store.savePending({ state, codeVerifier, ownerUserId, connectionId, createdAt: deps.now });
  return { url, connectionId };
}

export type ConnectResult = { channel: Pick<Channel, "channelId" | "connectionId" | "status" | "title">; scopes: string[] };

export async function completeConnect(deps: { store: YouTubeOAuthStore; env: Env; fetch: Fetch; now: string }, ownerUserId: string, code: string, state: string, profile: { language: string; niche: string; timezone: string; distributionProfile?: string }): Promise<ConnectResult> {
  const pending = await deps.store.takePending(state);
  if (!pending || pending.ownerUserId !== ownerUserId) throw new OAuthConfigError("unknown or foreign OAuth state");
  if (Date.parse(deps.now) - Date.parse(pending.createdAt) > 15 * 60_000) throw new OAuthConfigError("OAuth state expired");
  const cfg = oauthConfig(deps.env);
  const { refreshTokenEnc, scopes } = await exchangeCode(deps.fetch, cfg, deps.env, code, pending.codeVerifier);
  const required = scopesFor(READ_CAPS);
  const missing = required.filter((s) => !scopes.includes(s));
  if (missing.length) throw new OAuthConfigError(`consent did not grant read scopes: ${missing.join(", ")}`);
  const extra = scopes.filter((s) => !required.includes(s));
  if (extra.length) throw new OAuthConfigError(`consent granted more than read scopes (${extra.join(", ")}); refused in read-only V1`);
  // Identify the channel with a short-lived access token (never persisted).
  const token = await accessToken(deps.fetch, cfg, deps.env, refreshTokenEnc);
  const r = await deps.fetch(channelQuery(), { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new OAuthConfigError(`channels.list failed HTTP ${r.status}`);
  const list = (await r.json()) as ChannelListResponse;
  const item = list.items?.[0];
  if (!item) throw new OAuthConfigError("the Google account has no YouTube channel");
  const channel = ChannelSchema.parse({ channelId: item.id, ownerUserId, connectionId: pending.connectionId, title: item.snippet?.title ?? "", language: profile.language, niche: profile.niche, timezone: profile.timezone, distributionProfile: profile.distributionProfile ?? "default", connectedAt: deps.now, status: "connected" });
  // yt_oauth_connections.connection_id has an FK to yt_channels.connection_id.
  // Persist the parent first as pending, then the encrypted token envelope, and only
  // mark the channel connected after the token write succeeds. This also leaves a
  // truthful/retryable pending row if token persistence fails.
  await deps.store.upsertChannel({ ...channel, connectedAt: null, status: "pending" });
  await deps.store.saveConnection(pending.connectionId, refreshTokenEnc, scopes);
  await deps.store.upsertChannel(channel);
  return { channel: { channelId: channel.channelId, connectionId: channel.connectionId, status: channel.status, title: channel.title }, scopes };
}

/** Short-lived token for a stored connection (memory only; callers must not persist it). */
export async function tokenForConnection(deps: { store: YouTubeOAuthStore; env: Env; fetch: Fetch }, connectionId: string): Promise<string> {
  const c = await deps.store.getConnection(connectionId);
  if (!c) throw new OAuthConfigError("connection not found or revoked");
  return accessToken(deps.fetch, oauthConfig(deps.env), deps.env, c.refreshTokenEnc);
}
