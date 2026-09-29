# PI V1 — Freeze, DULCE benchmark, migration audit, Ocean shadow exam

Evidence: `docs/pi-exam/results.json` (produced by `scripts/pi-exam/exam.ts`, committed before its first run in `c67708d`; protocol pre-registered in `FREEZE.json`, `d82e757`).

## A. Freeze
Commit `d1330e7`; engine tree sha256 `c57bf623…1cc49` (identical before and after the exam); policy/1.0.0, longform-16x9/1, rate-card/2026-09-28.1, shot-contract/1, memory `mem_empty`; 30 PI/distribution/delivery tests, 1,279 in test:unit. Tag `PI_V1_FROZEN` exists locally; pushing tags is rejected by the environment (HTTP 403), so SHA + tree hash are the immutable identifiers.

## B/C. DULCE (in-sample)
| | clips | billed gen s | s/min | video USD | worst reserved |
|---|---|---|---|---|---|
| Human planned (Smart Mix B+) | 13 | 70 | 7.21 | 3.50 | plan B recorded 44.5 (incl. Creator 11) |
| Human used (master) | 11 | 60 | 6.18 | 3.00 (3.75 incl. failed attempts) | — |
| PI frozen | 14 | 75 | 7.72 | 3.75 | 30.15 (all stills × 2 attempts at 0.30 + video) |

| Comparison | ∩ | PI only | human only | precision | recall | Jaccard |
|---|---|---|---|---|---|---|
| PI vs planned | 8 | N09 N10 N21 N27 N32 N44 | N05 N26 N33 N43 N48 | 0.571 | 0.615 | 0.421 |
| PI vs used | 7 | N09 N10 N20 N21 N27 N32 N44 | N05 N26 N33 N48 | 0.500 | 0.636 | 0.389 |

Why: see FAILURE-ANALYSIS F2–F4. N20 is PI-only vs used only because Runway returned no video twice in reality (it was human-planned).

## D. Migration audit
- **Real history** (direct DB read impossible: runner lacks IPv6, the pooler host needs human confirmation; evidence = migration-apply workflow logs): production registered 0001–0019, then **0020 + 0021 applied on 2026-09-26 from `claude/voices-medieval-tts`** and **0022 on 2026-09-27 from `claude/tts-podcast`** — neither branch is merged; `main` and this branch do not contain 0020–0022.
- **Drift: YES** (repo lineage ≠ production). Applied content equals the branch files byte-for-byte (one hash per file across all branches), but the registry `public._migrations_applied(name, applied_at)` stores **no checksum**, so content cannot be verified from the database. **MIGRATION AUDIT = FAIL.**
- Expand-only (0023–0025): every statement is `create … if not exists`, new functions/triggers/policies on new tables, `enable row level security` on new tables; the only `drop … if exists` target objects created in the same file. **All EXPAND_ONLY**; the repo's own destructive-line detector flags nothing.
- Security (static + local Postgres test): RLS on all new tables; no client policy on ledger/telemetry/pins/tokens/delivery (anon/authenticated cannot read or write them); idempotency key = PRIMARY KEY, status forward-only trigger, final states immutable → **DB_ENFORCED**; owners read only their channels (verified). Pre-existing finding: `public._migrations_applied` is created by the apply script without RLS.
- Live-spend interaction: **NO** (only new tables; no existing table, column or worker code references them). No workflow in progress or queued now; app jobs in `video_requests` **UNKNOWN** (database not readable).
- **Recommendation: NEEDS_FIX** — bring 0020–0022 into the lineage that will apply 0023–0025, add a content checksum to the registry, and re-audit with a human-confirmed read-only connection. Nothing applied.

## E. Ocean baseline
Storyboard v003: 84 shots; old plan animated 9 (7 new Veo 8 s at USD 1.02 = 7.14 + 2 reused first-minute clips) = 72 billed s, 6.55 s/min. Manifest: 111 approved scenes, 8 Veo clips, all in b5 with different keys. Recorded: spent 13.36 (voice 3.21, images/clips 10.15), committed 14.32 of 17.65. UNKNOWN: per-shot actual cost, storyboard↔manifest mapping, final master, motion leverage.

## F. Ocean shadow (0 network calls, 0 spend)
| Scenario (AI_RECREATION leverage) | gen shots | gen s | s/min | video USD | expected | worst | constitution |
|---|---|---|---|---|---|---|---|
| S1 MEDIUM (primary) | 9 | 45 / 87 | 4.10 | 2.25 | 3.45 | 11.25 | 0 violations |
| S2 HIGH | 9 | 45 / 87 | 4.10 | 2.25 | 3.45 | 11.25 | 0 |
| S3 LOW | 0 | 0 | 0 | 0 | 1.04 | 7.80 | 0 |
Old vs PI cost is not like-for-like (Veo 8 s at ~USD 0.13/s estimates vs Runway 5 s at 0.05/s). Expensive false positives: **b1-s1, b1-s4** (approved, already paid — F1). Other selections: UNKNOWN (no human evidence that motion was unnecessary). Quality false negatives: none in S1/S2. Reasons coverage 100%; deterministic; budget and hero quota respected. Does 8 s/min produce absurd decisions in Ocean? **NO** (it never binds: 45/87 s). Human-used overlap: not computed (no shot-level reference; not fabricated). Planned overlap 9/9 is circular (FAILURE-ANALYSIS caveat).

## G. Ocean verdict: **FAIL**
0 constitutional violations, reproducible, fully explained and within budget — but PI would pay again for two approved, already-paid assets, with explicit human evidence that they cost nothing to reuse. That is the exact financial behavior PI exists to prevent.

## H. Next step
Open **PI V1.1 as CANDIDATE** with only the F1 fix (existing approved assets are never upgrade candidates), and re-run this same frozen exam in Shadow before anything else — no migration, pilot or worker change until it passes.
