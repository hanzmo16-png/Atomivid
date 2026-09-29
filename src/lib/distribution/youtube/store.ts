/**
 * Persistence port for the read-only YouTube layer. The memory store backs tests; the
 * Supabase store writes with the SERVICE ROLE only (server side), matching migrations
 * 0024 + 0026. Nothing here reads or returns a refresh token in plaintext.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetricRow } from "./analytics";
import type { ChannelSnapshot } from "./channel-snapshot";
import type { ProductionLink } from "./link";
import type { VideoObservation } from "./memory";
import type { Channel } from "./channels";
import type { PerformanceSnapshot } from "./snapshots";
import type { LaunchRecord } from "./launch-record";

export type PendingConnection = { state: string; codeVerifier: string; ownerUserId: string; connectionId: string; createdAt: string };

export interface YouTubeStore {
  savePending(p: PendingConnection): Promise<void>;
  takePending(state: string): Promise<PendingConnection | null>;
  upsertChannel(c: Channel): Promise<void>;
  saveConnection(connectionId: string, refreshTokenEnc: string, scopes: string[]): Promise<void>;
  getConnection(connectionId: string): Promise<{ refreshTokenEnc: string; scopes: string[] } | null>;
  upsertLink(l: ProductionLink): Promise<void>;
  listLinks(channelId: string): Promise<ProductionLink[]>;
  upsertRows(rows: MetricRow[]): Promise<{ written: number }>;
  upsertObservation(o: VideoObservation): Promise<void>;
  saveChannelSnapshot(s: ChannelSnapshot): Promise<void>;
  listPerformanceSnapshots(channelId: string, videoId: string): Promise<PerformanceSnapshot[]>;
  /** Idempotent by snapshotKey; a COLLECTED snapshot is never overwritten. */
  upsertPerformanceSnapshots(s: PerformanceSnapshot[]): Promise<void>;
  saveLaunchRecord(r: LaunchRecord): Promise<void>;
  getLaunchRecord(launchId: string): Promise<LaunchRecord | null>;
}

export function memoryYouTubeStore(): YouTubeStore & { rows: Map<string, MetricRow>; links: Map<string, ProductionLink>; snapshots: ChannelSnapshot[]; connections: Map<string, { refreshTokenEnc: string; scopes: string[] }>; channels: Map<string, Channel>; observations: Map<string, VideoObservation>; performance: Map<string, PerformanceSnapshot>; launches: Map<string, LaunchRecord> } {
  const pending = new Map<string, PendingConnection>();
  const s = {
    rows: new Map<string, MetricRow>(), links: new Map<string, ProductionLink>(), snapshots: [] as ChannelSnapshot[], connections: new Map<string, { refreshTokenEnc: string; scopes: string[] }>(), channels: new Map<string, Channel>(), observations: new Map<string, VideoObservation>(), performance: new Map<string, PerformanceSnapshot>(), launches: new Map<string, LaunchRecord>(),
    async listPerformanceSnapshots(channelId: string, videoId: string) { return [...s.performance.values()].filter((x) => x.channelId === channelId && x.videoId === videoId); },
    async upsertPerformanceSnapshots(list: PerformanceSnapshot[]) { for (const x of list) { const cur = s.performance.get(x.snapshotKey); if (cur?.status === "COLLECTED") continue; s.performance.set(x.snapshotKey, x); } },
    async saveLaunchRecord(r: LaunchRecord) { s.launches.set(r.launchId, r); },
    async getLaunchRecord(id: string) { return s.launches.get(id) ?? null; },
    async savePending(p: PendingConnection) { pending.set(p.state, p); },
    async takePending(state: string) { const p = pending.get(state) ?? null; pending.delete(state); return p; },
    async upsertChannel(c: Channel) { s.channels.set(c.channelId, c); },
    async saveConnection(id: string, refreshTokenEnc: string, scopes: string[]) { s.connections.set(id, { refreshTokenEnc, scopes }); },
    async getConnection(id: string) { return s.connections.get(id) ?? null; },
    async upsertLink(l: ProductionLink) { s.links.set(l.linkKey, l); },
    async listLinks(channelId: string) { return [...s.links.values()].filter((l) => l.channelId === channelId && l.status === "linked"); },
    async upsertRows(rows: MetricRow[]) { for (const r of rows) s.rows.set(r.rowKey, r); return { written: rows.length }; },
    async upsertObservation(o: VideoObservation) { s.observations.set(`${o.channelId}:${o.videoId}`, o); },
    async saveChannelSnapshot(x: ChannelSnapshot) { if (!s.snapshots.some((y) => y.snapshotKey === x.snapshotKey)) s.snapshots.push(x); },
  };
  return s;
}

const fail = (op: string, e: { message: string } | null) => { if (e) throw new Error(`youtube store ${op}: ${e.message}`); };

export function supabaseYouTubeStore(sb: SupabaseClient): YouTubeStore {
  return {
    async savePending(p) { fail("savePending", (await sb.from("yt_pending_connections").insert({ state: p.state, code_verifier: p.codeVerifier, owner_user_id: p.ownerUserId, connection_id: p.connectionId, created_at: p.createdAt })).error); },
    async takePending(state) {
      const { data, error } = await sb.from("yt_pending_connections").delete().eq("state", state).select().maybeSingle();
      fail("takePending", error);
      return data ? { state: data.state, codeVerifier: data.code_verifier, ownerUserId: data.owner_user_id, connectionId: data.connection_id, createdAt: data.created_at } : null;
    },
    async upsertChannel(c) { fail("upsertChannel", (await sb.from("yt_channels").upsert({ channel_id: c.channelId, owner_user_id: c.ownerUserId, connection_id: c.connectionId, title: c.title, language: c.language, niche: c.niche, timezone: c.timezone, distribution_profile: c.distributionProfile, connected_at: c.connectedAt, status: c.status })).error); },
    async saveConnection(connectionId, refreshTokenEnc, scopes) { fail("saveConnection", (await sb.from("yt_oauth_connections").upsert({ connection_id: connectionId, refresh_token_enc: refreshTokenEnc, scopes })).error); },
    async getConnection(connectionId) {
      const { data, error } = await sb.from("yt_oauth_connections").select("refresh_token_enc,scopes,revoked_at").eq("connection_id", connectionId).maybeSingle();
      fail("getConnection", error);
      return data && !data.revoked_at ? { refreshTokenEnc: data.refresh_token_enc, scopes: data.scopes } : null;
    },
    async upsertLink(l) { fail("upsertLink", (await sb.from("yt_video_links").upsert({ link_key: l.linkKey, project_id: l.projectId, request_id: l.requestId, master_checksum_sha256: l.masterChecksumSha256, master_storage_path: l.masterStoragePath, channel_id: l.channelId, video_id: l.videoId, published_at: l.publishedAt, linked_at: l.linkedAt, linked_by: l.linkedBy, status: l.status })).error); },
    async listLinks(channelId) {
      const { data, error } = await sb.from("yt_video_links").select("*").eq("channel_id", channelId).eq("status", "linked");
      fail("listLinks", error);
      return (data ?? []).map((d) => ({ linkKey: d.link_key, projectId: d.project_id, requestId: d.request_id, masterChecksumSha256: d.master_checksum_sha256, masterStoragePath: d.master_storage_path, channelId: d.channel_id, videoId: d.video_id, publishedAt: d.published_at, linkedAt: d.linked_at, linkedBy: d.linked_by, status: d.status }));
    },
    async upsertRows(rows) {
      if (!rows.length) return { written: 0 };
      fail("upsertRows", (await sb.from("yt_metric_rows").upsert(rows.map((r) => ({ row_key: r.rowKey, channel_id: r.channelId, video_id: r.videoId, metric: r.metric, value: r.value, dimension_value: r.dimensionValue, dimension_label: r.dimensionLabel ?? null, window_start: r.windowStart, window_end: r.windowEnd, source: r.source, collected_at: r.collectedAt })))).error);
      return { written: rows.length };
    },
    async upsertObservation(o) { fail("upsertObservation", (await sb.from("yt_video_observations").upsert({ channel_id: o.channelId, video_id: o.videoId, published_at: o.publishedAt, topic: o.topic, title_structure: o.titleStructure, thumbnail_metadata: o.thumbnailMetadata, duration_seconds: o.durationSeconds, hook_structure: o.hookStructure })).error); },
    async saveChannelSnapshot(x) { fail("saveChannelSnapshot", (await sb.from("yt_channel_snapshots").upsert({ snapshot_key: x.snapshotKey, channel_id: x.channelId, collected_at: x.collectedAt, subscribers: x.subscribers, total_views: x.totalViews, video_count: x.videoCount, watch_time_minutes: x.watchTimeMinutes, window_start: x.windowStart, window_end: x.windowEnd, uploads_playlist_id: x.uploadsPlaylistId })).error); },
    async listPerformanceSnapshots(channelId, videoId) {
      const { data, error } = await sb.from("yt_performance_snapshots").select("*").eq("channel_id", channelId).eq("video_id", videoId);
      fail("listPerformanceSnapshots", error);
      return (data ?? []).map((d) => ({ snapshotKey: d.snapshot_key, channelId: d.channel_id, videoId: d.video_id, window: d.window, dueAt: d.due_at, status: d.status, collectedAt: d.collected_at, metrics: d.metrics ?? {}, source: d.source, lastFailure: d.last_failure, attempts: d.attempts }));
    },
    async upsertPerformanceSnapshots(list) {
      if (!list.length) return;
      // The database trigger refuses to rewrite a COLLECTED snapshot; skip those client side too.
      const existing = await Promise.all(list.map((x) => sb.from("yt_performance_snapshots").select("status").eq("snapshot_key", x.snapshotKey).maybeSingle()));
      const writable = list.filter((_, i) => existing[i].data?.status !== "COLLECTED");
      if (!writable.length) return;
      fail("upsertPerformanceSnapshots", (await sb.from("yt_performance_snapshots").upsert(writable.map((x) => ({ snapshot_key: x.snapshotKey, channel_id: x.channelId, video_id: x.videoId, window: x.window, due_at: x.dueAt, status: x.status, collected_at: x.collectedAt, metrics: x.metrics, source: x.source, last_failure: x.lastFailure, attempts: x.attempts, updated_at: new Date().toISOString() })))).error);
    },
    async saveLaunchRecord(r) { fail("saveLaunchRecord", (await sb.from("yt_launch_records").upsert({ launch_id: r.launchId, production_id: r.productionId, master_id: r.masterId, master_hash: r.masterHash, master_storage_path: r.masterStoragePath, final_cut_status: r.finalCutStatus, final_cut_report_id: r.finalCutReportId, title: r.title, description: r.description, chapters: r.chapters, language: r.language, thumbnail_reference: r.thumbnailReference, visibility_intent: r.visibilityIntent, channel_id: r.channelId, youtube_video_id: r.youtubeVideoId, published_at: r.publishedAt, published_by: r.publishedBy, status: r.status, created_at: r.createdAt })).error); },
    async getLaunchRecord(launchId) {
      const { data, error } = await sb.from("yt_launch_records").select("*").eq("launch_id", launchId).maybeSingle();
      fail("getLaunchRecord", error);
      return data ? { launchId: data.launch_id, productionId: data.production_id, masterId: data.master_id, masterHash: data.master_hash, masterStoragePath: data.master_storage_path, finalCutStatus: data.final_cut_status, finalCutReportId: data.final_cut_report_id, title: data.title, description: data.description, chapters: data.chapters, language: data.language, thumbnailReference: data.thumbnail_reference, visibilityIntent: data.visibility_intent, channelId: data.channel_id, youtubeVideoId: data.youtube_video_id, publishedAt: data.published_at, publishedBy: data.published_by, status: data.status, createdAt: data.created_at } : null;
    },
  };
}
