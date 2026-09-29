# Production Core + YouTube read-only monitoring (2026-09-29)

This layer finishes the infrastructure that must exist before the next Long Form (Thermopylae / Leonidas) is used as a blind test. It is additive: no existing pipeline file changed, and the frozen PI V1.1 engine (`src/lib/production-intelligence`, tree `fb24a402…a2cbef`, pre-registered in `content/blind-projects/iron-annals-001/protocol.json`) is imported, never modified.

## What already existed and is reused
| need | existing component |
|---|---|
| shot contract for the engine | `production-intelligence/contract.ts` (`ShotContract`) |
| ladder, decide(), Mix Engine with anti-slideshow | `production-intelligence/{ladder,decide,mix}.ts` (V1.1) |
| rate card + per-shot cost arithmetic | `production-intelligence/{rate-card,cost}.ts` |
| worst-case reservation, kill switch | `production-intelligence/budget.ts` |
| idempotent paid operations | `production-intelligence/ledger.ts` |
| QA/asset state machine | `production-intelligence/state-machine.ts` |
| capacity core (UNKNOWN never GREEN), adapters, account registry | `production-intelligence/capacity/*` |
| Long Form shot, provenance, durable assets | `video/long-form/{types,durable-shot-assets}.ts` |
| YouTube OAuth, capabilities, analytics rows, memory, launch package | `distribution/youtube/*` + migration 0024 |

## New: `src/lib/production-core/`
| file | role |
|---|---|
| `shot-record.ts` | `ProductionShotRecord`: PI contract embedded + scene/block, narrative purpose, asset type, provider, duration target, min visible, camera, transition, character references, continuity, historical classification, subtitle interaction, provenance, expected/reserved/actual cost, lifecycle state, QA status, retry count, fallback state. `recordFromLongFormShot` maps an existing `Shot`. |
| `timeline-rules.ts` | Configurable mix rules (`TIMELINE_RULES_V1`): static runs, opening motion from 0 s, hook density, min visible, text/black card limits, speech timing, repetition, meaningful camera, deterministic transitions. |
| `policy-engine.ts` | `PRODUCTION_POLICY_V1`: provider eligibility per asset type, aspect/resolution, project/provider/shot ceilings, premium allocation (hero quota from the PI profile), retry limits, fallback rules, provenance/content rules, concurrency. |
| `cost-engine.ts` | `CostLedger`: ESTIMATED → RESERVED → ACTUAL per request/provider/shot/asset type; idempotent commits; conflicts flagged for reconciliation; **top-ups are balance events, never COGS**. |
| `recovery.ts` | REUSE / RESUME_IN_FLIGHT / GENERATE / REGENERATE / RECONCILE / HUMAN_REVIEW / SKIP_CANCELLED from state + ledger + durable assets. |
| `admission.ts` | "Can this job be safely accepted?": HEALTHY / LIMITED / INSUFFICIENT / UNKNOWN per provider, configured spending ceilings, reserved + queued demand, depletion forecast; UNKNOWN needs an explicit operator acceptance. |
| `pipeline.ts` | Generic chain topic → script → storyboard → shot contracts → cost estimate → capacity check → production → QA → master → YouTube link → analytics as a zero-network dry run. No topic-specific code. |

## New: YouTube read-only monitoring (`src/lib/distribution/youtube/`)
| file | role |
|---|---|
| `analytics.ts` (extended) | `averagePercentageViewed`, traffic sources (`insightTrafficSourceType`), `manual_entry` rows for Studio-only impressions / CTR (the public API does not expose them; nothing is invented). |
| `video-data.ts` | Data API v3 `videos.list`: title, publishedAt, duration, public counters. |
| `channel-snapshot.ts` | `channels.list` statistics, channel watch time, uploads playlist (publishing history). |
| `time-series.ts` | 24h / 48h / 7d / 28d windows, only when elapsed; no interpolation. |
| `link.ts` | request → master checksum → channel → video id; validated, idempotent. |
| `monitor.ts` | one read-only run per linked video; GET-only to an endpoint allowlist. |
| `store.ts` | port + memory store + Supabase (service role) store. |
| `connect-flow.ts` + `src/app/api/distribution/youtube/{connect,callback}` | server-side consent with READ scopes only; refresh token encrypted at rest; a consent that grants more than read scopes is refused. |
| `scripts/youtube-monitor.ts` | CLI for a monitoring run (`--dry-run` writes nothing). |
| migration `0026_youtube_read_only_monitoring.sql` | `yt_video_links`, `yt_channel_snapshots`, `yt_pending_connections`, `dimension_label`, wider metric/source domains with a manual-only CHECK. NOT applied. |

## Human actions still required
1. Google Cloud: create the OAuth client (Web), set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`; generate `YOUTUBE_TOKEN_ENC_KEY`. The consent screen must enable the YouTube Data API v3 and YouTube Analytics API.
2. Apply migrations 0023–0026 with explicit authorization (all verified locally; see `supabase/migration-manifest.json`).
3. Connect @TheIronAnnals through `POST /api/distribution/youtube/connect` and complete the consent (read-only).
4. After a manual publication, create the link (`createLink` → `store.upsertLink`) and run `scripts/youtube-monitor.ts`.
