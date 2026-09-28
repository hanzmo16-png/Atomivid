# ATOMIVID Production Hardening V1 (proposal, not implemented)

Target architecture approved as product direction: pre-generation budget gate, quote before paid generation,
idempotent paid operations, persistent financial ledger, durable workflows, provider concurrency limits,
cost-aware production ladder, cheap QA cascade, semantic fallback down the ladder, cost-per-approved-shot telemetry.
This mission only plans it; implementation starts after DULCE Part I is finished and measured.

What exists today (DULCE path): per-episode ledger JSON in Storage with unique claim keys (`claims/<key>.json`,
written with `upsert:false`), a USD ceiling checked before each claim, and a durable Runway wrapper that records
STARTED/COMPLETED per clip so an interrupted run reconciles instead of resubmitting. It runs inside GitHub Actions.

| # | What | Why | Complexity | Estimate | Dependencies |
|---|---|---|---|---|---|
| 1 | **Idempotency ledger** as a Postgres table (`spend_operations`): states `reserved → submitted → committed` or `→ refunded`; one row per paid call with provider job id, amount reserved vs. actual, timestamps. Transitions in a single SQL function with row locks. | The Storage JSON ledger is last-writer-wins and can lose updates under concurrency; money needs transactional state. | Medium | 2–3 days | Supabase migration; existing `claims` semantics as the spec |
| 2 | **Unique idempotency keys**: `hash(project, asset, stage, attempt, input checksum)` as a UNIQUE column; the provider request carries it where supported (Runway/OpenAI idempotency headers) and our own reconciliation otherwise. | A retry after a timeout must find the existing job, never submit a second paid one. | Low–Medium | 1 day | #1 |
| 3 | **Project hard spend cap**: `reserve()` checks `committed + reserved + amount <= cap` inside the same transaction; over cap returns a typed error and stops the workflow for approval. | Today's ceiling check is in process memory per run; two concurrent runs could both pass it. | Low | 0.5 day | #1 |
| 4 | **Automatic refund on system failure**: a reservation whose provider call never reached `submitted` (network error, crash before submit) is released automatically; `submitted` without result is reconciled by polling the provider, then committed or released. | Budget must not leak into phantom reservations; money is only committed when the provider accepted work. | Medium | 1–2 days | #1, #2, provider status APIs |
| 5 | **Cancellation stops future spend**: a project `status=cancelled` flag checked by `reserve()`; in-flight jobs finish or are cancelled at the provider, no new reservations. | The owner must be able to stop a run and know nothing else will be charged. | Low | 0.5 day | #1, #6 |
| 6 | **Durable workflow engine** for paid operations: recommend **Inngest** or **Trigger.dev** (managed, TypeScript, step-level retries and idempotent steps, sleeps/polls without holding a runner). Each paid call = one step: reserve → submit → poll → commit. | GitHub Actions has 6 h limits, no step idempotency, secrets in CI, and no queue semantics; it cannot be the payment path for customers. | Medium–High | 4–6 days incl. migration of the DULCE stages | #1–#5 |
| 7 | **Paid API operations outside GitHub Actions**: Actions keeps CI, tests and read-only diagnostics; provider keys move to the workflow runtime only. | Least privilege, auditable spend, no paid work triggered by a push. | Low (once #6 exists) | 0.5 day | #6 |
| 8 | **Object storage for video intermediates**: clips, segments and masters in an S3-compatible bucket without the 50 MB object limit (Cloudflare R2: no egress fees), lifecycle rules (intermediates 30 days, masters kept), content-addressed keys by sha256; Supabase keeps metadata. | The current bucket rejects whole masters (>50 MB) and forces part-splitting and HLS workarounds. | Medium | 2 days | Bucket + credentials; update render/upload helpers |
| 9 | **Provider concurrency limits**: per-provider semaphore in the workflow engine (e.g. Runway 3, OpenAI images 3, ElevenLabs 2) plus rate-limit backoff. | Avoids 429 storms, duplicated submissions and runaway parallel spend. | Low | 0.5 day | #6 |
| 10 | **Global generation kill switch**: one config flag (DB row or env) checked by `reserve()`; flipping it blocks every new paid reservation within seconds. | Incident response: stop all spend instantly without redeploying. | Low | 0.5 day | #1 |
| 11 | **Per-tenant limits**: monthly USD cap, concurrent jobs and max per-project cap per customer; enforced in `reserve()`; usage view per tenant. | Required before paying customers; one tenant cannot exhaust shared provider quota or budget. | Medium | 2 days | #1, #3, auth/tenant model |
| 12 | **Pre-generation quote**: planner emits a quote (images, clip seconds by tier, voice characters, retry reserve, worst case) that must be approved to create the project cap. | "Quote before paid generation" becomes a system step, as done manually for DULCE. | Medium | 1–2 days | Storyboard schema (DULCE Part I format), #3 |

Suggested order: 1 → 2 → 3 → 10 → 5 → 4 → 6 → 7 → 9 → 8 → 12 → 11 (about 3–4 weeks of focused work).
Explicitly out of scope for now: learned or ML routing, Kafka, Temporal, own GPUs, self-hosted FLUX, self-service Long Form, final pricing.
