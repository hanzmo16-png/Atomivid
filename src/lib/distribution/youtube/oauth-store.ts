/**
 * Persistence port for the READ-ONLY OAuth connect flow ONLY: pending consent state, the
 * encrypted refresh-token envelope and the channel row. It is the subset of the general
 * YouTubeStore that connect/callback need, kept separate so those routes never import
 * monitoring, launch records, links or any write-capable module. The Supabase implementation
 * writes with the SERVICE ROLE server side into the existing tables yt_pending_connections,
 * yt_oauth_connections and yt_channels (RLS enabled; no client policy on tokens). No migration.
 * Nothing here reads or returns a refresh token in plaintext.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel } from "./channels";

export type PendingConnection = { state: string; codeVerifier: string; ownerUserId: string; connectionId: string; createdAt: string };
export type StoredConnection = { refreshTokenEnc: string; scopes: string[] };

export interface YouTubeOAuthStore {
  savePending(p: PendingConnection): Promise<void>;
  /** One-time: returns and deletes the pending state in one step. */
  takePending(state: string): Promise<PendingConnection | null>;
  saveConnection(connectionId: string, refreshTokenEnc: string, scopes: string[]): Promise<void>;
  /** Encrypted envelope only; null when unknown or revoked. */
  getConnection(connectionId: string): Promise<StoredConnection | null>;
  upsertChannel(c: Channel): Promise<void>;
}

export function memoryYouTubeOAuthStore(): YouTubeOAuthStore & { pending: Map<string, PendingConnection>; connections: Map<string, StoredConnection>; channels: Map<string, Channel> } {
  const s = {
    pending: new Map<string, PendingConnection>(), connections: new Map<string, StoredConnection>(), channels: new Map<string, Channel>(),
    async savePending(p: PendingConnection) { s.pending.set(p.state, p); },
    async takePending(state: string) { const p = s.pending.get(state) ?? null; s.pending.delete(state); return p; },
    async saveConnection(id: string, refreshTokenEnc: string, scopes: string[]) { s.connections.set(id, { refreshTokenEnc, scopes }); },
    async getConnection(id: string) { return s.connections.get(id) ?? null; },
    async upsertChannel(c: Channel) { s.channels.set(c.channelId, c); },
  };
  return s;
}

const fail = (op: string, e: { message: string } | null) => { if (e) throw new Error(`youtube oauth store ${op}: ${e.message}`); };

export function supabaseYouTubeOAuthStore(sb: SupabaseClient): YouTubeOAuthStore {
  return {
    async savePending(p) { fail("savePending", (await sb.from("yt_pending_connections").insert({ state: p.state, code_verifier: p.codeVerifier, owner_user_id: p.ownerUserId, connection_id: p.connectionId, created_at: p.createdAt })).error); },
    async takePending(state) {
      const { data, error } = await sb.from("yt_pending_connections").delete().eq("state", state).select().maybeSingle();
      fail("takePending", error);
      return data ? { state: data.state, codeVerifier: data.code_verifier, ownerUserId: data.owner_user_id, connectionId: data.connection_id, createdAt: data.created_at } : null;
    },
    async saveConnection(connectionId, refreshTokenEnc, scopes) { fail("saveConnection", (await sb.from("yt_oauth_connections").upsert({ connection_id: connectionId, refresh_token_enc: refreshTokenEnc, scopes })).error); },
    async getConnection(connectionId) {
      const { data, error } = await sb.from("yt_oauth_connections").select("refresh_token_enc,scopes,revoked_at").eq("connection_id", connectionId).maybeSingle();
      fail("getConnection", error);
      return data && !data.revoked_at ? { refreshTokenEnc: data.refresh_token_enc, scopes: data.scopes } : null;
    },
    async upsertChannel(c) { fail("upsertChannel", (await sb.from("yt_channels").upsert({ channel_id: c.channelId, owner_user_id: c.ownerUserId, connection_id: c.connectionId, title: c.title, language: c.language, niche: c.niche, timezone: c.timezone, distribution_profile: c.distributionProfile, connected_at: c.connectedAt, status: c.status })).error); },
  };
}
