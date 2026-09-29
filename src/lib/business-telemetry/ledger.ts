/**
 * Business Telemetry V0 — the ONE controlled write path: recordBusinessEvent().
 * validate → sanitize → idempotency → persist → canonical event. No module writes SQL to the
 * ledger directly. Append-only: the store only knows insertIfAbsent; the database refuses
 * UPDATE/DELETE by trigger (migration 0030). Invalid events are never accepted silently: every
 * refusal is typed, recorded in the rejection sink (no payload, only a key hash) and thrown.
 */
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTOR_TYPES, EVENT_SCHEMAS, PROVENANCE, REQUIRED_REFERENCES, SCHEMA_VERSION, isEventType, type ActorType, type EventType, type Provenance } from "./taxonomy";
import { sanitizeMetadata } from "./sanitize";

export type BusinessEventInput = {
  eventType: EventType | string;
  occurredAt: string;
  actorType: ActorType;
  actorId?: string | null;
  userId?: string | null;
  productionId?: string | null;
  requestId?: string | null;
  masterId?: string | null;
  provider?: string | null;
  source: string;
  provenance: Provenance;
  schemaVersion?: number;
  metadata: unknown;
  /** Caller-owned, deterministic for the same business fact (webhook id, canonical row key, …). */
  idempotencyKey: string;
};

export type BusinessEvent = {
  eventId: string;
  eventType: EventType;
  schemaVersion: number;
  occurredAt: string;
  recordedAt: string;
  actorType: ActorType;
  actorId: string | null;
  userId: string | null;
  productionId: string | null;
  requestId: string | null;
  masterId: string | null;
  provider: string | null;
  source: string;
  provenance: Provenance;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  payloadHash: string;
};

export const REJECTION_REASONS = ["unknown_event_type", "invalid_schema", "invalid_currency", "forbidden_metadata", "secret_like_value", "missing_provenance", "missing_reference", "invalid_timestamp", "invalid_actor", "schema_version_mismatch", "idempotency_conflict", "persistence_failure"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];
export type EventRejection = { rejectedAt: string; eventType: string | null; reason: RejectionReason; detail: string; idempotencyKeyHash: string | null; source: string | null };

export class BusinessEventRejected extends Error {
  constructor(public readonly reason: RejectionReason, public readonly detail: string) { super(`${reason}: ${detail}`); this.name = "BusinessEventRejected"; }
}

export interface BusinessEventStore {
  /** Inserts the event unless one with the same event_id exists; never updates. */
  insertIfAbsent(event: BusinessEvent): Promise<{ inserted: boolean; existing: BusinessEvent | null }>;
}
export interface RejectionSink { record(r: EventRejection): Promise<void>; }

export type RecordResult = { status: "recorded" | "duplicate"; event: BusinessEvent };
export type LedgerDeps = { store: BusinessEventStore; rejections?: RejectionSink; now: () => string; /** tolerated clock skew for observed_live events, seconds */ maxFutureSkewSeconds?: number };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const eventIdFor = (idempotencyKey: string) => `bev_${sha256(idempotencyKey).slice(0, 32)}`;
export const keyHash = (idempotencyKey: string) => sha256(idempotencyKey).slice(0, 32);
const canonical = (v: unknown): string => JSON.stringify(sort(v));
const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
const nz = (v: string | null | undefined) => (v === undefined || v === null || v === "" ? null : String(v));

export async function recordBusinessEvent(input: BusinessEventInput, deps: LedgerDeps): Promise<RecordResult> {
  const now = deps.now();
  const reject = async (reason: RejectionReason, detail: string): Promise<never> => {
    await deps.rejections?.record({ rejectedAt: now, eventType: typeof input.eventType === "string" ? input.eventType.slice(0, 80) : null, reason, detail: detail.slice(0, 300), idempotencyKeyHash: typeof input.idempotencyKey === "string" && input.idempotencyKey ? keyHash(input.idempotencyKey) : null, source: nz(input.source)?.slice(0, 80) ?? null });
    throw new BusinessEventRejected(reason, detail);
  };

  if (!isEventType(input.eventType)) return reject("unknown_event_type", `"${String(input.eventType).slice(0, 80)}" is not in the V0 taxonomy`);
  const eventType: EventType = input.eventType;
  if (!(PROVENANCE as readonly string[]).includes(input.provenance) || !nz(input.source)) return reject("missing_provenance", "source and provenance (observed_live | derived_from_canonical_record) are required");
  if (!(ACTOR_TYPES as readonly string[]).includes(input.actorType)) return reject("invalid_actor", `actor_type "${String(input.actorType).slice(0, 40)}"`);
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 300) return reject("invalid_schema", "idempotency_key must be a deterministic string of 8..300 chars");
  const version = input.schemaVersion ?? SCHEMA_VERSION;
  if (version !== SCHEMA_VERSION) return reject("schema_version_mismatch", `schema_version ${version} is not ${SCHEMA_VERSION}`);
  const occurred = Date.parse(input.occurredAt);
  if (!Number.isFinite(occurred) || !/^\d{4}-\d{2}-\d{2}T/.test(input.occurredAt)) return reject("invalid_timestamp", "occurred_at must be an ISO-8601 timestamp");
  if (occurred > Date.parse(now) + (deps.maxFutureSkewSeconds ?? 300) * 1000) return reject("invalid_timestamp", "occurred_at is in the future");
  const refs = { userId: nz(input.userId), productionId: nz(input.productionId), masterId: nz(input.masterId), provider: nz(input.provider) };
  for (const r of REQUIRED_REFERENCES[eventType]) if (!refs[r]) return reject("missing_reference", `${eventType} requires ${r}`);

  const clean = sanitizeMetadata(input.metadata);
  if (!clean.ok) return reject(clean.reason, clean.detail);
  const parsed = EVENT_SCHEMAS[eventType].safeParse(clean.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "metadata"}: ${i.message}`);
    const currency = issues.some((i) => /currency/.test(i));
    return reject(currency ? "invalid_currency" : "invalid_schema", issues.slice(0, 5).join("; "));
  }

  const metadata = parsed.data as Record<string, unknown>;
  const occurredAt = new Date(occurred).toISOString();
  const payloadHash = sha256(canonical({ eventType, schemaVersion: version, occurredAt, ...refs, requestId: nz(input.requestId), actorType: input.actorType, actorId: nz(input.actorId), metadata }));
  const event: BusinessEvent = { eventId: eventIdFor(input.idempotencyKey), eventType, schemaVersion: version, occurredAt, recordedAt: now, actorType: input.actorType, actorId: nz(input.actorId), ...refs, requestId: nz(input.requestId), source: input.source, provenance: input.provenance, idempotencyKey: input.idempotencyKey, metadata, payloadHash };

  let outcome: { inserted: boolean; existing: BusinessEvent | null };
  try { outcome = await deps.store.insertIfAbsent(event); }
  catch (e) { return reject("persistence_failure", e instanceof Error ? e.message : String(e)); }
  if (outcome.inserted) return { status: "recorded", event };
  if (!outcome.existing) return reject("persistence_failure", "store reported a duplicate without returning it");
  if (outcome.existing.payloadHash !== payloadHash) return reject("idempotency_conflict", `idempotency_key already recorded a DIFFERENT fact (${outcome.existing.eventType} at ${outcome.existing.occurredAt})`);
  return { status: "duplicate", event: outcome.existing };
}

// ---------- stores ----------
export class MemoryBusinessEventStore implements BusinessEventStore {
  readonly events = new Map<string, BusinessEvent>();
  lastSuccessfulWriteAt: string | null = null;
  failNext: Error | null = null;
  async insertIfAbsent(e: BusinessEvent) {
    if (this.failNext) { const err = this.failNext; this.failNext = null; throw err; }
    const existing = this.events.get(e.eventId);
    if (existing) return { inserted: false, existing };
    this.events.set(e.eventId, structuredClone(e));
    this.lastSuccessfulWriteAt = e.recordedAt;
    return { inserted: true, existing: null };
  }
  list(): BusinessEvent[] { return [...this.events.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)); }
}
export class MemoryRejectionSink implements RejectionSink {
  readonly rejections: EventRejection[] = [];
  async record(r: EventRejection) { this.rejections.push(r); }
}

const toRow = (e: BusinessEvent) => ({ event_id: e.eventId, event_type: e.eventType, schema_version: e.schemaVersion, occurred_at: e.occurredAt, recorded_at: e.recordedAt, actor_type: e.actorType, actor_id: e.actorId, user_id: e.userId, production_id: e.productionId, request_id: e.requestId, master_id: e.masterId, provider: e.provider, source: e.source, provenance: e.provenance, idempotency_key: e.idempotencyKey, metadata: e.metadata, payload_hash: e.payloadHash });
export const fromRow = (d: Record<string, unknown>): BusinessEvent => ({ eventId: String(d.event_id), eventType: String(d.event_type) as EventType, schemaVersion: Number(d.schema_version), occurredAt: new Date(String(d.occurred_at)).toISOString(), recordedAt: new Date(String(d.recorded_at)).toISOString(), actorType: String(d.actor_type) as ActorType, actorId: nz(d.actor_id as string | null), userId: nz(d.user_id as string | null), productionId: nz(d.production_id as string | null), requestId: nz(d.request_id as string | null), masterId: nz(d.master_id as string | null), provider: nz(d.provider as string | null), source: String(d.source), provenance: String(d.provenance) as Provenance, idempotencyKey: String(d.idempotency_key), metadata: (d.metadata ?? {}) as Record<string, unknown>, payloadHash: String(d.payload_hash) });

/** Service-role only (RLS has no client policies). Insert; on a unique violation the existing row is returned, never updated. */
export function supabaseBusinessEventStore(sb: SupabaseClient): BusinessEventStore {
  return {
    async insertIfAbsent(e) {
      const ins = await sb.from("business_events").insert(toRow(e));
      if (!ins.error) return { inserted: true, existing: null };
      if (ins.error.code !== "23505") throw new Error(`business_events insert failed: ${ins.error.message}`);
      const { data, error } = await sb.from("business_events").select("*").eq("event_id", e.eventId).maybeSingle();
      if (error) throw new Error(`business_events read-back failed: ${error.message}`);
      return { inserted: false, existing: data ? fromRow(data as Record<string, unknown>) : null };
    },
  };
}
export function supabaseRejectionSink(sb: SupabaseClient): RejectionSink {
  return { async record(r) { await sb.from("business_event_rejections").insert({ rejected_at: r.rejectedAt, event_type: r.eventType, reason: r.reason, detail: r.detail, idempotency_key_hash: r.idempotencyKeyHash, source: r.source }); } };
}
