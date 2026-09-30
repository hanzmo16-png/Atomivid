/**
 * Command Center data sources: raw, read-only rows fetched in a FIXED number of queries per
 * section (no per-row fan-out). The memory source backs tests; the Supabase source uses the
 * service role server-side only, behind requireCommandCenterAdmin. Nothing here aggregates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimeRange } from "./windows";

export type RequestRow = { id: string; userId: string; mode: string | null; status: string; createdAt: string; renderAttempts: number | null; renderStartedAt: string | null; longFormStage: string | null };
export type CostRow = { requestId: string; estimatedCostUsd: number | null; imageProvider: string | null; imageCostUsd: number | null; premiumVideoProvider: string | null; premiumVideoCostUsd: number | null; avatarCostUsd: number | null; voiceProvider: string | null; footageProvider: string | null; renderMs: number | null; regenerations: number | null };
export type PaidOpRow = { projectId: string; provider: string; method: string; reservedUsd: number; committedUsd: number | null; status: string; updatedAt: string };
export type CapacityRow = { provider: string; unit: string; available: number | null; reserved: number; pending: number; status: string; reliability: string; renewalDate: string | null; checkedAt: string };
export type SubscriptionRow = { userId: string; status: string; priceId: string | null; createdAt: string };
export type UserRow = { id: string; createdAt: string; lastSignInAt: string | null };
export type FcDecisionRow = { productionId: string; masterId: string; toState: string; decidedAt: string };
export type YtLinkRow = { projectId: string; channelId: string; videoId: string; publishedAt: string | null };
export type YtRowLite = { channelId: string; videoId: string; metric: string; value: number; dimensionLabel: string | null; dimensionValue: number | null; windowStart: string; windowEnd: string; source: string; collectedAt: string };
export type YtChannelRow = { channelId: string; status: string; title: string };

/** `null` from any method means the source is UNAVAILABLE (table missing, query failed), distinct from an empty list. */
export interface CommandCenterSource {
  users(r: TimeRange): Promise<{ total: number | null; newInRange: number | null; activeInRange: number | null }>;
  subscriptions(): Promise<SubscriptionRow[] | null>;
  requests(r: TimeRange): Promise<RequestRow[] | null>;
  costs(requestIds: string[]): Promise<CostRow[] | null>;
  paidOps(r: TimeRange): Promise<PaidOpRow[] | null>;
  capacity(): Promise<CapacityRow[] | null>;
  finalCutDecisions(r: TimeRange): Promise<FcDecisionRow[] | null>;
  youtubeChannels(): Promise<YtChannelRow[] | null>;
  youtubeLinks(): Promise<YtLinkRow[] | null>;
  youtubeRows(r: TimeRange): Promise<YtRowLite[] | null>;
}

export type MemoryData = Partial<{ users: { total: number; rows: UserRow[] }; subscriptions: SubscriptionRow[]; requests: RequestRow[]; costs: CostRow[]; paidOps: PaidOpRow[]; capacity: CapacityRow[]; finalCut: FcDecisionRow[]; ytChannels: YtChannelRow[]; ytLinks: YtLinkRow[]; ytRows: YtRowLite[] }> & { unavailable?: (keyof CommandCenterSource)[] };

export function memorySource(d: MemoryData): CommandCenterSource {
  const un = new Set(d.unavailable ?? []);
  const inR = (iso: string | null | undefined, r: TimeRange) => !!iso && (r.fromIso === null || iso >= r.fromIso) && iso <= r.toIso;
  return {
    async users(r) { if (un.has("users") || !d.users) return { total: null, newInRange: null, activeInRange: null }; return { total: d.users.total, newInRange: d.users.rows.filter((u) => inR(u.createdAt, r)).length, activeInRange: d.users.rows.filter((u) => inR(u.lastSignInAt, r)).length }; },
    async subscriptions() { return un.has("subscriptions") ? null : d.subscriptions ?? []; },
    async requests(r) { return un.has("requests") ? null : (d.requests ?? []).filter((x) => inR(x.createdAt, r)); },
    async costs(ids) { return un.has("costs") ? null : (d.costs ?? []).filter((c) => ids.includes(c.requestId)); },
    async paidOps(r) { return un.has("paidOps") ? null : (d.paidOps ?? []).filter((x) => inR(x.updatedAt, r)); },
    async capacity() { return un.has("capacity") ? null : d.capacity ?? []; },
    async finalCutDecisions(r) { return un.has("finalCutDecisions") ? null : (d.finalCut ?? []).filter((x) => inR(x.decidedAt, r)); },
    async youtubeChannels() { return un.has("youtubeChannels") ? null : d.ytChannels ?? []; },
    async youtubeLinks() { return un.has("youtubeLinks") ? null : d.ytLinks ?? []; },
    async youtubeRows(r) { return un.has("youtubeRows") ? null : (d.ytRows ?? []).filter((x) => inR(x.collectedAt, r)); },
  };
}

/** Supabase source: one query per table per call; errors become `null` (UNAVAILABLE), never zeros. */
export function supabaseSource(sb: SupabaseClient): CommandCenterSource {
  const q = async <T>(run: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, map: (row: Record<string, unknown>) => T): Promise<T[] | null> => {
    try { const { data, error } = await run(); if (error) return null; return ((data ?? []) as Record<string, unknown>[]).map(map); } catch { return null; }
  };
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const range = <B extends { gte: (c: string, v: string) => B; lte: (c: string, v: string) => B }>(b: B, col: string, r: TimeRange): B => (r.fromIso ? b.gte(col, r.fromIso).lte(col, r.toIso) : b.lte(col, r.toIso));
  return {
    async users(r) {
      // auth.users is not readable through PostgREST; user counts come from the admin API (paged, capped) and stay null when unavailable.
      try {
        const total = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
        if (total.error) return { total: null, newInRange: null, activeInRange: null };
        const all: { created_at: string; last_sign_in_at?: string | null }[] = [];
        for (let page = 1; page <= 20; page++) { const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 }); if (error) break; all.push(...data.users); if (data.users.length < 1000) break; }
        const inR = (iso: string | null | undefined) => !!iso && (r.fromIso === null || iso >= r.fromIso) && iso <= r.toIso;
        return { total: all.length, newInRange: all.filter((u) => inR(u.created_at)).length, activeInRange: all.filter((u) => inR(u.last_sign_in_at)).length };
      } catch { return { total: null, newInRange: null, activeInRange: null }; }
    },
    subscriptions: () => q(() => sb.from("subscriptions").select("user_id,status,price_id,created_at"), (d) => ({ userId: String(d.user_id), status: String(d.status), priceId: s(d.price_id), createdAt: String(d.created_at) })),
    requests: (r) => q(() => range(sb.from("video_requests").select("id,user_id,mode,status,created_at,render_attempts,render_started_at,long_form_stage"), "created_at", r), (d) => ({ id: String(d.id), userId: String(d.user_id), mode: s(d.mode), status: String(d.status), createdAt: String(d.created_at), renderAttempts: n(d.render_attempts), renderStartedAt: s(d.render_started_at), longFormStage: s(d.long_form_stage) })),
    costs: (ids) => (ids.length ? q(() => sb.from("generation_costs").select("request_id,estimated_cost_usd,image_provider,image_cost_usd,premium_video_provider,premium_video_cost_usd,avatar_cost_usd,voice_provider,footage_provider,render_ms,regenerations").in("request_id", ids), (d) => ({ requestId: String(d.request_id), estimatedCostUsd: n(d.estimated_cost_usd), imageProvider: s(d.image_provider), imageCostUsd: n(d.image_cost_usd), premiumVideoProvider: s(d.premium_video_provider), premiumVideoCostUsd: n(d.premium_video_cost_usd), avatarCostUsd: n(d.avatar_cost_usd), voiceProvider: s(d.voice_provider), footageProvider: s(d.footage_provider), renderMs: n(d.render_ms), regenerations: n(d.regenerations) })) : Promise.resolve([])),
    paidOps: (r) => q(() => range(sb.from("pi_paid_operations").select("project_id,provider,method,reserved_usd,committed_usd,status,updated_at"), "updated_at", r), (d) => ({ projectId: String(d.project_id), provider: String(d.provider), method: String(d.method), reservedUsd: Number(d.reserved_usd), committedUsd: n(d.committed_usd), status: String(d.status), updatedAt: String(d.updated_at) })),
    capacity: () => q(() => sb.from("pi_capacity_snapshots").select("provider,unit,available,reserved,pending,status,reliability,renewal_date,checked_at").order("checked_at", { ascending: false }).limit(50), (d) => ({ provider: String(d.provider), unit: String(d.unit), available: n(d.available), reserved: Number(d.reserved ?? 0), pending: Number(d.pending ?? 0), status: String(d.status), reliability: String(d.reliability), renewalDate: s(d.renewal_date), checkedAt: String(d.checked_at) })),
    finalCutDecisions: (r) => q(() => range(sb.from("fc_qa_decisions").select("production_id,master_id,to_state,decided_at"), "decided_at", r), (d) => ({ productionId: String(d.production_id), masterId: String(d.master_id), toState: String(d.to_state), decidedAt: String(d.decided_at) })),
    youtubeChannels: () => q(() => sb.from("yt_channels").select("channel_id,status,title"), (d) => ({ channelId: String(d.channel_id), status: String(d.status), title: String(d.title ?? "") })),
    youtubeLinks: () => q(() => sb.from("yt_video_links").select("project_id,channel_id,video_id,published_at").eq("status", "linked"), (d) => ({ projectId: String(d.project_id), channelId: String(d.channel_id), videoId: String(d.video_id), publishedAt: s(d.published_at) })),
    youtubeRows: (r) => q(() => range(sb.from("yt_metric_rows").select("channel_id,video_id,metric,value,dimension_label,dimension_value,window_start,window_end,source,collected_at"), "collected_at", r), (d) => ({ channelId: String(d.channel_id), videoId: String(d.video_id), metric: String(d.metric), value: Number(d.value), dimensionLabel: s(d.dimension_label), dimensionValue: n(d.dimension_value), windowStart: String(d.window_start), windowEnd: String(d.window_end), source: String(d.source), collectedAt: String(d.collected_at) })),
  };
}
