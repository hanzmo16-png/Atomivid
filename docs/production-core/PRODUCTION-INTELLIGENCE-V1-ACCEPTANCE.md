# Production Intelligence V1 — Deterministic Core: acceptance evidence (2026-10-01)

Status: **READY_FOR_VIDEO_003_ACCEPTANCE_TEST** (code on `claude/production-intelligence-v1`; not deployed).
Video #003 has NOT been started. Nothing here calls a billable API.

## Where each component lives (existing, reused unchanged)

| Mission component | Implementation | Deterministic tests |
| --- | --- | --- |
| 1. Shot contracts | `production-intelligence/contract.ts` (engine contract, frozen) embedded in `production-core/shot-record.ts` (`ProductionShotRecord`: scene, purpose, asset type, provider, duration target, min visible, camera, transition, character references, continuity group, provenance, expected/reserved/actual cost, lifecycle state, QA status, retry count, fallback state, decision hash) | `production-core.test.ts` "shot record", `manifest.test.ts` |
| 2. Mix engine | `production-intelligence/{mix,profiles,decide,ladder}.ts` (V1.1: generative-seconds budget, anti-slideshow, rhythm limits) + **new** `production-core/mix-presets.ts` (100% AI motion, 50/50 hybrid, 30/70 economical targets; `measureMix` / `checkMixPreset`) | PI tests 4, 5, T1–T12; `manifest.test.ts` "mix presets" |
| 3. Policy engine | `production-core/policy-engine.ts` (`PRODUCTION_POLICY_V1`: provider eligibility, aspect 16:9, 1920×1080@30, ceilings, retries, fallback, provenance, forbidden elements, concurrency) + `production-core/timeline-rules.ts` (`TIMELINE_RULES_V1`: static runs, opening motion from 0 s, hook density, min visible, text/black card ≤ limits, speech timing, repetition, meaningful camera, transitions) + `production-intelligence/policy.ts` (versioned, promotion is explicit) | "policy engine", "timeline rules", PI test 11 |
| 4. Cost engine / ledger | `production-core/cost-engine.ts` (ESTIMATED → RESERVED → ACTUAL per shot/provider/asset type, idempotent commits, conflicts → reconciliation, **top-ups never COGS**), `production-intelligence/budget.ts` (worst-case reservation, hard cap), `production-intelligence/ledger.ts` (idempotent paid operations, provider job id, resume, reconciliation) | "cost engine", "ledger + recovery", PI tests 1, 7, 8 |
| 5. QA state machine | `production-intelligence/state-machine.ts` (PLANNED → STILL_* → MOTION_* → LOCKED → RENDERED → DELIVERED / CANCELLED; a failed still never reaches motion), `final-cut/gate.ts` (production-level editorial states, HUMAN_REVIEW_REQUIRED), Final Cut inspectors (measured: audio/loudness, opening, rhythm, subtitles, black/freeze/resolution) with editorial judgement kept separate | "QA state machine", PI test 2, `final-cut.test.ts` |
| 6. Provider capacity | `production-intelligence/capacity/*` (snapshot, UNKNOWN never GREEN, buffer, depletion forecast, account registry without secrets), `production-core/admission.ts` (HEALTHY / LIMITED / INSUFFICIENT / UNKNOWN, ceilings, reserved + queued demand, NEEDS_OPERATOR) | "admission", PI tests 13, 14, 15, 18 |
| Cross-cutting idempotency | `ledger.ts` + `production-core/recovery.ts` (REUSE / RESUME_IN_FLIGHT / GENERATE / REGENERATE / RECONCILE / HUMAN_REVIEW) | "ledger + recovery", PI tests 7, 8 |
| Observability | **new** `production-core/manifest.ts` (`buildProductionManifest`) + **new** `scripts/production-dry-run.ts` | `manifest.test.ts` |
| Database | migrations 0023 (pi_paid_operations, telemetry, policy versions/history, memory snapshots, project pins, asset transitions, provider accounts, capacity snapshots), 0027 (Final Cut), all additive, applied + registered in production | verify/03, verify/05 |
| Minimum UI | Command Center (Production, Costs est/actual, Providers, System health, failures/retries) — deployed | `command-center*.test` |

New in this mission (outside the frozen engine, whose tree hash stays `fb24a4026e29815b9c8a2071e2db474d3d399adb50c933e276f1480f05a2cbef`):
`src/lib/production-core/manifest.ts`, `src/lib/production-core/mix-presets.ts`, `src/lib/production-core/manifest.test.ts`, `scripts/production-dry-run.ts`, this document and `docs/production-core/evidence/*.json`.

## Gate G — dry run without billable calls (`npx tsx scripts/production-dry-run.ts`)

Generic 40-shot fixture (9 stock, 2 hero AI-video candidates, 29 animated stills, no topic-specific rule), narration 9,800 characters, budget USD 40, ceilings openai 20 / runway 20 / elevenlabs 10. The pipeline throws on any `fetch`; `networkCalls = 0` in every scenario.

| scenario | ok | stages | generative | estimated | reserved (worst) | remaining budget | capacity | blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| healthy | true | 11/11 | 2 shots / 10 s of 28 s | USD 4.94 | USD 21.06 | USD 18.94 | ACCEPT (all HEALTHY) | none |
| insufficient-runway (available 0.5) | false | 11/11 | same plan | same | same | same | REJECT, runway INSUFFICIENT | "insufficient capacity: runway" |
| unknown-runway (no balance source) | false | 11/11 | same plan | same | same | same | NEEDS_OPERATOR, runway UNKNOWN | "capacity UNKNOWN … operator must accept explicitly" |
| budget-guard-120-shots | false | 11/11 | 0 | USD 9.56 | USD 58.96 | USD −18.96 | REJECT | worst case exceeds budget USD 40; project ceiling; provider ceiling |

Each manifest (`docs/production-core/evidence/dry-run-manifest-*.json`) contains: shot contracts with planned method, provider, decision hash, expected/reserved/actual cost, lifecycle/QA/retry/fallback state; mix measure and preset check; cost by provider with retry cost, variance, remaining budget and top-ups excluded; capacity per provider; policy and timeline findings; the QA plan (technical checks vs editorial checks that remain human); pins (policy/1.1.0-candidate, longform-16x9/1.1, shot-contract/1, rate-card/2026-09-28.1, mem_empty). Same inputs → byte-identical manifest (tested).

## Gate H — idempotent retry (mocks)

`manifest.test.ts` "explicit fallback and retries": the same idempotency key executed twice creates ONE paid operation (`executePaidOperation` returns the stored COMMITTED result); a materially different attempt (new fingerprint, ordinal 2, `simplified_retry`) is a second operation. Manifest: `actualUsd 0.50`, `retryUsd 0.25`, both operations listed under the shot with provider job id. `production-core.test.ts` "ledger + recovery" and PI tests 7/8 cover semantic vs transport retries and RECONCILIATION_REQUIRED.

## Gate I — insufficient capacity

Dry-run scenario `insufficient-runway`: verdict REJECT, `runway INSUFFICIENT`, `ok=false`, plan still fully inspectable, nothing reserved as spendable. `unknown-runway`: NEEDS_OPERATOR, never accepted silently.

## Gate J — explicit fallback, no silent degradation

Fallback is a shot state (`fallbackState`: STILL_MOTION_FALLBACK / STOCK_FALLBACK / TEXT_CARD_FALLBACK / HUMAN_REVIEW) and a QA status (`FALLBACK`), both carried into the manifest per shot with `explicit: true`. `PRODUCTION_POLICY_V1.resolution` is fixed at 1920×1080@30 and no 720p path exists: a resolution downgrade cannot happen silently because it cannot happen at all under V1 policy (a future policy version must introduce it explicitly).

## Compatibility

Ocean and DULCE pipelines are untouched (no file under `video/long-form`, `remotion` or the render worker changed). DULCE regression: PI test T11 (0 unjustified generative upgrades on the real DULCE timeline) still passes.

## Remaining limitations

- The dry-run pipeline maps every still method to `openai` and every generative method to `runway`; text/diagram/map shots therefore trigger `P_PROVIDER_ELIGIBILITY` / `R_CAMERA_MEANINGFUL` blockers when included. Graphics are rendered internally and should be kept out of the paid mix in the dry run until the router (docs/production-core/PROVIDER-ROUTER-CONTRACT.md) is wired.
- `production_completed / failed` events and live shot-record persistence are not emitted by the current worker; the manifest is built from the dry run plus ledger rows.
- Mix presets are measured and reported; they do not drive the Mix Engine's decisions (the frozen engine decides by contract, budget and rhythm).
- Provider capacity for Runway is ledger-derived (no balance API); ElevenLabs/OpenAI adapters exist but run only when explicitly authorized.
