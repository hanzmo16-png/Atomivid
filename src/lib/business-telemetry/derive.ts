/**
 * Business Telemetry V0 — derivation from canonical records (backfill policy).
 * An event may be derived ONLY when the canonical row is unambiguous, carries the real
 * timestamp of the fact, names its source and yields a reproducible idempotency key.
 * Otherwise: NO EVENT (the function returns null). Nothing here invents history: video_requests
 * has no completion/failure timestamp, so production_completed/failed are never derived.
 */
import type { BusinessEventInput } from "./ledger";
import { PRODUCTION_TYPES } from "./taxonomy";

const PROV = "derived_from_canonical_record" as const;
const productionType = (mode: string | null): (typeof PRODUCTION_TYPES)[number] => (mode === "long_form" ? "long_form" : mode === "avatar" || mode === "hybrid" ? "avatar" : mode === "visual" ? "reel" : mode === "tts_podcast" ? "tts_podcast" : "unknown");
const validIso = (s: string | null | undefined): s is string => typeof s === "string" && Number.isFinite(Date.parse(s));

export const NOT_DERIVABLE: Record<string, string> = {
  production_completed: "video_requests stores status='completed' but no completion timestamp; must be observed live by the pipeline",
  production_failed: "video_requests stores status='failed' but no failure timestamp; must be observed live by the pipeline",
  subscription_started: "subscriptions has created_at/updated_at of the row, not of the Stripe event; Stripe webhook not wired to telemetry",
  subscription_cancelled: "same as subscription_started",
  payment_succeeded: "no payment ledger; Stripe invoice events are not consumed",
};

export type RequestRecord = { id: string; userId: string; mode: string | null; createdAt: string; language?: string | null; durationSeconds?: number | null; renderStartedAt?: string | null; renderAttempts?: number | null };
export function deriveProductionRequested(r: RequestRecord, source = "video_requests"): BusinessEventInput | null {
  if (!validIso(r.createdAt) || !r.id || !r.userId) return null;
  return { eventType: "production_requested", occurredAt: r.createdAt, actorType: "user", actorId: r.userId, userId: r.userId, productionId: r.id, requestId: r.id, source, provenance: PROV, idempotencyKey: `production_requested:video_requests:${r.id}`, metadata: { production_type: productionType(r.mode), language: r.language === "es" || r.language === "en" ? r.language : null, duration_seconds_requested: r.durationSeconds && r.durationSeconds > 0 ? Math.round(r.durationSeconds) : null } };
}
export function deriveProductionStarted(r: RequestRecord, source = "video_requests"): BusinessEventInput | null {
  if (!validIso(r.renderStartedAt) || !r.id) return null;
  return { eventType: "production_started", occurredAt: r.renderStartedAt, actorType: "job", actorId: null, userId: r.userId, productionId: r.id, requestId: r.id, source, provenance: PROV, idempotencyKey: `production_started:video_requests:${r.id}:${r.renderStartedAt}`, metadata: { production_type: productionType(r.mode), attempt: Math.max(1, Math.round(r.renderAttempts ?? 1)) } };
}

export type FinalCutDecisionRecord = { id: number | string; productionId: string; masterId: string; fromState: string; toState: string; decidedAt: string; reportId?: string | null; humanOverride?: unknown };
export function deriveFinalCutDecision(d: FinalCutDecisionRecord, source = "fc_qa_decisions"): BusinessEventInput | null {
  const type = d.toState === "EDITORIAL_QA_PASS" ? "final_cut_passed" : d.toState === "EDITORIAL_QA_FAIL" ? "final_cut_failed" : d.toState === "HUMAN_REVIEW_REQUIRED" ? "final_cut_human_review" : null;
  if (!type || !validIso(d.decidedAt) || !d.productionId || !d.masterId || d.id === undefined || d.id === null || d.id === "") return null;
  return { eventType: type, occurredAt: d.decidedAt, actorType: d.humanOverride ? "admin" : "system", actorId: null, productionId: d.productionId, masterId: d.masterId, source, provenance: PROV, idempotencyKey: `${type}:fc_qa_decisions:${d.id}`, metadata: { report_id: d.reportId ?? null, from_state: d.fromState, decided_by: d.humanOverride ? "human" : "gate" } };
}

export type VideoLinkRecord = { linkKey: string; projectId: string; requestId?: string | null; channelId: string; videoId: string; masterChecksumSha256: string; linkedAt: string; linkedBy: string; status: string };
export function deriveYouTubeLinked(l: VideoLinkRecord, source = "yt_video_links"): BusinessEventInput | null {
  if (l.status !== "linked" || !validIso(l.linkedAt)) return null;
  return { eventType: "youtube_video_linked", occurredAt: l.linkedAt, actorType: "admin", actorId: l.linkedBy, productionId: l.projectId, requestId: l.requestId ?? null, source, provenance: PROV, idempotencyKey: `youtube_video_linked:yt_video_links:${l.linkKey}`, metadata: { channel_id: l.channelId, video_id: l.videoId, master_checksum_sha256: l.masterChecksumSha256, linked_by: l.linkedBy } };
}

export type SnapshotRecord = { snapshotKey: string; channelId: string; videoId: string; window: string; status: string; collectedAt: string | null; productionId?: string | null };
export function deriveYouTubeSnapshot(s: SnapshotRecord, source = "yt_performance_snapshots"): BusinessEventInput | null {
  if (s.status !== "COLLECTED" || !validIso(s.collectedAt)) return null;
  return { eventType: "youtube_snapshot_collected", occurredAt: s.collectedAt, actorType: "job", actorId: null, productionId: s.productionId ?? null, source, provenance: PROV, idempotencyKey: `youtube_snapshot_collected:yt_performance_snapshots:${s.snapshotKey}`, metadata: { channel_id: s.channelId, video_id: s.videoId, window: s.window, snapshot_key: s.snapshotKey } };
}

export type AuthUserRecord = { id: string; createdAt: string; visitorId?: string | null };
export function deriveUserRegistered(u: AuthUserRecord, source = "auth.users"): BusinessEventInput | null {
  if (!validIso(u.createdAt) || !u.id) return null;
  return { eventType: "user_registered", occurredAt: u.createdAt, actorType: "user", actorId: u.id, userId: u.id, source, provenance: PROV, idempotencyKey: `user_registered:auth.users:${u.id}`, metadata: { visitor_id: u.visitorId ?? null, registration_method: "unknown" } };
}
