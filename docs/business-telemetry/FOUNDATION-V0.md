# Business Telemetry Foundation V0 — COLLECT EARLY, AUTOMATE LATE

Status: implemented and tested locally; **migration 0030 NOT applied to production** (needs a
separate human authorization). Nothing here recommends, predicts, decides, spends or moves money.

## Sources of truth (discovered, reused, never recomputed)

| Fact | Canonical owner | Telemetry relation |
| --- | --- | --- |
| Production request, mode, language, render start | `video_requests` | `production_requested`, `production_started` derived with the row's real timestamps |
| Actual provider cost | Cost Engine (`src/lib/production-core/cost-engine.ts`, COMMITTED entries) and `pi_paid_operations` (COMMITTED rows) | `provider_consumption_recorded` copies the committed figure; top-ups are refused |
| Editorial decision | `fc_qa_decisions` | `final_cut_passed / failed / human_review` derived from `to_state` + `decided_at` |
| YouTube link / snapshot | `yt_video_links`, `yt_performance_snapshots` | `youtube_video_linked`, `youtube_snapshot_collected` |
| Subscription state | `subscriptions` (Stripe webhook `src/app/api/stripe/webhook/route.ts`) | contract only: no event emitted (no event timestamp, webhook not wired to telemetry) |
| Registration | `auth.users.created_at` | `user_registered` |

## What exists

- `src/lib/business-telemetry/taxonomy.ts` — 14 event types, strict versioned zod schemas
  (`schema_version = 1`), required references per type, `EVENT_SOURCE_STATUS` (live / derivable /
  contract-only), ISO-4217 `Money` (amount + currency, no FX).
- `sanitize.ts` — forbidden key names (passwords, tokens, keys, cookies, card data, IP, e-mail…),
  secret-like value detection, size/depth limits. Runs before schema validation; rejects, never trims.
- `ledger.ts` — `recordBusinessEvent()` is the ONLY write path: validate → sanitize → idempotency →
  persist → canonical event. `event_id = bev_ + sha256(idempotency_key)[:32]`; a duplicate key with
  the same payload hash is `duplicate` (one record), with a different payload is an
  `idempotency_conflict` rejection. Every rejection is typed and logged (reason + key hash only).
  Stores: in-memory (tests) and Supabase service-role (`business_events`, `business_event_rejections`).
- `attribution.ts` — allowlisted `utm_*`, `gclid`, `fbclid`, path-only landing page; touches are
  append-only per anonymous `visitor_id` (linked to a user by `user_registered.visitor_id`);
  `resolveTouches()` gives FIRST and LAST touch. No multi-touch, no ad platform.
- `provider-trace.ts` — builds consumption events only from COMMITTED Cost Engine entries or
  paid-operation rows; refuses RECONCILIATION_REQUIRED and every balance event (top-up / credit);
  `traceProduction()` reconstructs "this video cost X because it used Runway + OpenAI + ElevenLabs",
  including fallbacks (`attempt_kind = fallback`, `fallback_from_provider`), summed per currency.
- `derive.ts` — derivations with `provenance = derived_from_canonical_record`; returns `null`
  (NO EVENT) when the timestamp or identity is missing; `NOT_DERIVABLE` documents why
  `production_completed/failed` and billing events are never derived.
- `health.ts` — HEALTHY / DEGRADED / UNKNOWN from facts (last successful write, validation and
  persistence failures). UNKNOWN is never HEALTHY.
- `command-center.ts` — read-only `TelemetrySource` + `aggregateTelemetry()`; the Command Center
  service exposes a `telemetry` section and field (UNAVAILABLE when 0030 is not applied). The
  screen is unchanged.
- `supabase/migrations/0030_business_telemetry_foundation.sql` — three append-only tables, RLS
  enabled with NO policies, client privileges revoked, `bt_append_only()` trigger with pinned
  search_path. Verified by `verify/08_business_telemetry_test.sql`.

## Backfill policy

Only `derived_from_canonical_record` with a real timestamp, an identifiable source and a
reproducible key. No event is written by this mission; derivation functions exist so a future,
authorized job can run them idempotently. `observed_live` is reserved for facts written when
they happen (pipeline, webhooks) — not wired in V0.

## Pending (explicit)

- Billing events: contract defined, integration pending a reliable Stripe source.
- `production_completed / failed`: need a live emission point in the pipeline (no timestamp in the table).
- Applying 0030 to production (separate authorization). Registry note: 0023–0029 are present in
  production but unregistered in `_migrations_applied` (see docs/security/DB-HARDENING-V1.md).
