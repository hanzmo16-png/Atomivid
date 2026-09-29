/**
 * Business Telemetry V0 — event taxonomy. SMALL and STABLE on purpose.
 * Every event type has an explicit, versioned, STRICT metadata schema (unknown keys are
 * rejected: metadata is never a dumping ground). Money never travels without a currency and
 * is never converted. Nothing here predicts, recommends or recalculates: the Cost Engine,
 * Production, Final Cut, Distribution and Billing stay the single sources of truth; telemetry
 * only records that a fact happened and how it relates to users, productions and providers.
 */
import { z } from "zod";

export const TELEMETRY_VERSION = "business-telemetry/0";
export const SCHEMA_VERSION = 1;

export const ACTOR_TYPES = ["system", "user", "admin", "webhook", "job"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
/** observed_live = written when the fact happened; derived_from_canonical_record = read later from an unambiguous canonical row with its real timestamp. */
export const PROVENANCE = ["observed_live", "derived_from_canonical_record"] as const;
export type Provenance = (typeof PROVENANCE)[number];

/** ISO 4217 codes accepted in V0. No FX, no conversion: original_amount + original_currency are preserved as recorded. */
export const ISO_4217 = ["USD", "MXN", "EUR", "GBP", "CAD", "BRL", "ARS", "COP", "CLP", "PEN", "UYU", "JPY", "AUD", "CHF", "INR", "KRW", "SEK", "NOK", "DKK", "PLN", "CZK", "NZD", "SGD", "HKD", "ZAR"] as const;
export const Money = z.strictObject({ amount: z.number().finite().nonnegative(), currency: z.enum(ISO_4217) });
export type Money = z.infer<typeof Money>;

export const PRODUCTION_TYPES = ["reel", "long_form", "avatar", "tts_podcast", "unknown"] as const;
const ProductionType = z.enum(PRODUCTION_TYPES);
const Language = z.enum(["es", "en"]).nullable();
const Id = z.string().min(1).max(200);
const Provider = z.string().min(1).max(40).regex(/^[a-z0-9_.-]+$/);
const YtChannel = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
const YtVideo = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const FinalCutDecision = z.strictObject({ report_id: Id.nullable(), from_state: z.string().min(1).max(40), decided_by: z.enum(["gate", "human"]) });

export const EVENT_SCHEMAS = {
  user_registered: z.strictObject({ visitor_id: Id.nullable(), registration_method: z.enum(["email", "oauth", "unknown"]) }),

  production_requested: z.strictObject({ production_type: ProductionType, language: Language, duration_seconds_requested: z.number().int().positive().nullable() }),
  production_started: z.strictObject({ production_type: ProductionType, attempt: z.number().int().positive() }),
  production_completed: z.strictObject({ production_type: ProductionType, duration_seconds: z.number().positive().nullable(), language: Language, provider_mix: z.array(Provider).max(20) }),
  production_failed: z.strictObject({ production_type: ProductionType, stage: z.string().max(60).nullable(), error_class: z.string().max(80).nullable() }),

  final_cut_passed: FinalCutDecision,
  final_cut_failed: FinalCutDecision,
  final_cut_human_review: FinalCutDecision,

  /** REAL, attributable consumption only. A top-up / recharge is a balance event and is refused upstream (provider-trace.ts). */
  provider_consumption_recorded: z.strictObject({
    cost_source: z.enum(["cost_engine", "pi_paid_operations"]),
    operation_key: Id,
    shot_id: Id.nullable(),
    model: z.string().max(80).nullable(),
    method: z.string().min(1).max(60),
    attempt_kind: z.enum(["initial", "retry", "fallback"]),
    fallback_from_provider: Provider.nullable(),
    units: z.strictObject({ quantity: z.number().finite().nonnegative(), unit: z.enum(["usd", "seconds", "characters", "images", "tokens", "calls"]) }).nullable(),
    actual: Money,
    consumption_kind: z.literal("committed_consumption"),
  }),

  youtube_video_linked: z.strictObject({ channel_id: YtChannel, video_id: YtVideo, master_checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/), linked_by: z.string().min(1).max(40) }),
  youtube_snapshot_collected: z.strictObject({ channel_id: YtChannel, video_id: YtVideo, window: z.enum(["24h", "48h", "7d", "28d"]), snapshot_key: Id }),

  // Billing: CONTRACT ONLY in V0 (no reliable live source is wired; see EVENT_SOURCE_STATUS). Money always carries a currency.
  subscription_started: z.strictObject({ billing_provider: z.literal("stripe"), external_subscription_ref: Id, plan: z.string().min(1).max(80), amount: Money.nullable() }),
  subscription_cancelled: z.strictObject({ billing_provider: z.literal("stripe"), external_subscription_ref: Id, cancel_at_period_end: z.boolean() }),
  payment_succeeded: z.strictObject({ billing_provider: z.literal("stripe"), external_payment_ref: Id, amount: Money }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];
export const isEventType = (v: unknown): v is EventType => typeof v === "string" && v in EVENT_SCHEMAS;
export type EventMetadata<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;

export type ReferenceKey = "userId" | "productionId" | "masterId" | "provider";
/** References every event of a type MUST carry, so relations can be rebuilt later (campaign → user → production → …). */
export const REQUIRED_REFERENCES: Record<EventType, ReferenceKey[]> = {
  user_registered: ["userId"],
  production_requested: ["userId", "productionId"],
  production_started: ["productionId"],
  production_completed: ["productionId"],
  production_failed: ["productionId"],
  final_cut_passed: ["productionId", "masterId"],
  final_cut_failed: ["productionId", "masterId"],
  final_cut_human_review: ["productionId", "masterId"],
  provider_consumption_recorded: ["productionId", "provider"],
  youtube_video_linked: ["productionId"],
  youtube_snapshot_collected: [],
  subscription_started: ["userId"],
  subscription_cancelled: ["userId"],
  payment_succeeded: ["userId"],
};

/** Where each event can honestly come from TODAY. Contract-only types are defined but never emitted until a real source exists. */
export const EVENT_SOURCE_STATUS: Record<EventType, { status: "live_source_available" | "derivable_from_canonical_record" | "contract_only_pending_integration"; source: string }> = {
  user_registered: { status: "derivable_from_canonical_record", source: "auth.users.created_at" },
  production_requested: { status: "derivable_from_canonical_record", source: "video_requests.created_at" },
  production_started: { status: "derivable_from_canonical_record", source: "video_requests.render_started_at (only when present)" },
  production_completed: { status: "contract_only_pending_integration", source: "video_requests has status but NO completion timestamp — must be observed live by the pipeline; never derived" },
  production_failed: { status: "contract_only_pending_integration", source: "video_requests has status but NO failure timestamp — must be observed live by the pipeline; never derived" },
  final_cut_passed: { status: "derivable_from_canonical_record", source: "fc_qa_decisions (to_state = EDITORIAL_QA_PASS, decided_at)" },
  final_cut_failed: { status: "derivable_from_canonical_record", source: "fc_qa_decisions (to_state = EDITORIAL_QA_FAIL, decided_at)" },
  final_cut_human_review: { status: "derivable_from_canonical_record", source: "fc_qa_decisions (to_state = HUMAN_REVIEW_REQUIRED, decided_at)" },
  provider_consumption_recorded: { status: "derivable_from_canonical_record", source: "Cost Engine COMMITTED entries / pi_paid_operations COMMITTED rows (never top-ups)" },
  youtube_video_linked: { status: "derivable_from_canonical_record", source: "yt_video_links (status = linked, linked_at)" },
  youtube_snapshot_collected: { status: "derivable_from_canonical_record", source: "yt_performance_snapshots (status = COLLECTED, collected_at)" },
  subscription_started: { status: "contract_only_pending_integration", source: "Stripe webhook not wired to telemetry; subscriptions table has no event timestamps" },
  subscription_cancelled: { status: "contract_only_pending_integration", source: "Stripe webhook not wired to telemetry" },
  payment_succeeded: { status: "contract_only_pending_integration", source: "no payment ledger exists; Stripe invoice events not consumed" },
};
