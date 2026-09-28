# Production Intelligence V1

**What.** A deterministic layer (`src/lib/production-intelligence/`) that decides how each shot is produced, how much generative motion a whole video may have, what may be spent, and what happens after a failure. AI stays creative (scripts, storyboards, visual intent, shot-contract proposals); money, methods, retries, QA gates, capacity and idempotency are decided by versioned code.

**Why.** DULCE showed the failure modes: 44 locally "animatable" shots (Plan A, 38.9 generated s/min) against 11 clips actually worth using; paid assets missing from the render; stills animated after failing QA; quota discovered mid-production.

## Pieces
| Module | Role |
|---|---|
| `contract.ts` | Shot Contract (zod): the only input the engine reads; no project names or raw prompts |
| `profiles.ts` | `LONGFORM_16X9`, `SHORT_9X16`, `AVATAR`: methods, generative s/min + cap, hero quota, attempts |
| `ladder.ts` | EXISTING → STOCK → AI_STILL → KEN_BURNS → PARALLAX → I2V_ECONOMY → I2V_HERO |
| `rate-card.ts`, `cost.ts` | Versioned prices (mirroring the adapters) and pure arithmetic: expected / worst / reserved / committed / refunded |
| `decide.ts` | `decide(contract, profile, policy, rateCard, memorySnapshotId, pin, attempt, failure, budget, …)` → method, providers, maxCost, attempts, downgrade, `reasons[]`, `decisionHash`. Fallback is part of it |
| `mix.ts` | Whole-timeline allocation: floor for all, rank by motion leverage, upgrade only within the generative-seconds budget, hero quota and project budget |
| `budget.ts` | Reserve the WORST authorized cost before the first paid call; release the rest at settlement; per-call kill switch |
| `ledger.ts` | Idempotent paid operations: RESERVED → SUBMITTED → PROVIDER_JOB_RECORDED → COMMITTED / REFUNDED / RECONCILIATION_REQUIRED |
| `state-machine.ts` | Asset lifecycle PLANNED → … → DELIVERED; QA executors report, the gate decides |
| `qa-gate.ts` | Finding → PASS / PASS_WITH_NOTE / TRIM / FALLBACK / FAIL; R11 unused paid asset audit |
| `telemetry.ts`, `memory.ts`, `shadow.ts`, `policy.ts`, `pin.ts` | Append-only events, read-only memory, shadow policies, explicit promotion, per-project pinned versions |

## Rules (general, not DULCE-specific)
R01 multi_human + economy → no generative video (profile exception only) · R02 human_creature needs HIGH leverage · R03 failed still → no motion · R04 identity-critical human without HIGH leverage → still-motion · R05 complex hands / R06 enter-exit frame need HIGH leverage · R07 never repeat an identical paid attempt · R08 semantic failure → one materially simpler attempt (HIGH only) or downgrade · R09 one infrastructure retry under the same idempotency key · R10 hero only from the global quota · R11 paid + approved + intended asset missing from the master → QA FAIL. LOW motion leverage is never upgraded.

## Invariants (tests: `src/lib/production-intelligence/production-intelligence.test.ts`)
Worst case ≤ reserved budget · failed still cannot reach motion · multi_human economy never generative · mix within the generative budget · DULCE-like timeline does not animate everything · same inputs → same decision (hash) · semantic failure never repeated · transport retry keeps the key and never double-charges · shadow never calls providers · model versions never share statistics · a project cannot change global policy · R11 · reserved capacity reduces free · insufficient capacity RED/BLOCKED · UNKNOWN never GREEN · no secrets in telemetry/logs · human intervention identified · pinned snapshot stable.

## DULCE validation (no spend)
`fixtures/dulce-mix-contracts.json` holds the 44 real Smart Mix candidates as contracts. With `LONGFORM_16X9` (8 s/min, budget 77 s) the engine chooses **14 generative shots (1 hero), 75/77 s**, expected USD 7.27, reserved worst case USD 30.15 (within 40). R04 independently keeps N43 still — the clip that failed identity QA in real production. Regenerate fixtures: `python3 scripts/lib/pi-build-dulce-fixtures.py`.

## How to test
`node --import tsx --test src/lib/production-intelligence/production-intelligence.test.ts` (also part of `npm run test:unit`).

## Not implemented yet
Wiring into the Long Form worker (the core is ready but not called by existing pipelines); Supabase-backed stores for ledger/telemetry (tables exist in migration 0023, not applied); any learned or data-driven policy (see POLICY-PROMOTION.md); automatic QA executors beyond ffmpeg/OpenCV already in the repo.
