# PI V1.1 CANDIDATE: targeted fixes, migration reconciliation, adversarial re-exam

Evidence:
- `docs/pi-exam/results-v1_1.json`, produced by `scripts/pi-exam/exam-v1_1.ts`, which was committed in `a4eff3f` before its first run;
- `FREEZE-V1_1.json`;
- `MIGRATION-HISTORY.md`;
- `NEW-FINDINGS.md`;
- `PILOT-GATE-V1_1.md`.

## A. V1 preserved
- **Frozen evidence untouched.** V1 is `d1330e7` with engine tree `c57bf623…1cc49`. `results.json`, `REPORT.md`, `FAILURE-ANALYSIS.md` and `FREEZE.json` are unchanged, as is the V1 test file (22/22 pass).
- **V1 behavior is policy-gated.** Every new behavior sits behind optional params that `POLICY_V1` does not set. The V1 exam re-run on the V1.1 tree gives identical decisions; only the tree-hash stamp differs.

## B. V1.1 candidate
- **Identity.**
  - Policy `policy/1.1.0-candidate` (CANDIDATE); profile `longform-16x9/1.1`.
  - Engine commit `a4eff3f`, engine tree `fb24a4026e29815b9c8a2071e2db474d3d399adb50c933e276f1480f05a2cbef`.
  - Rate card, contract version, memory snapshot and the 8 s/min ceiling are unchanged.
- **Code changes.**
  - `contract.ts`: optional 1.1 reuse and replacement fields.
  - `decide.ts`: rule R12, plus `upgradeReason` validation.
  - `mix.ts`: the candidate pool as a ceiling, and the rhythm pass.
  - `policy.ts` / `profiles.ts`: the new versions.
- **Tests.** T1–T12 plus a V1-shape guard: 13 new tests. `test:unit` passes 1,293/1,293; lint and typecheck are clean.
- **Tag.** Local tag `PI_V1_1_CANDIDATE_FROZEN`; pushing it is rejected (403), so SHA + tree hash are the authority.

## C. Fix A: reuse / no repurchase (R12)
- **Rule.** existing + approved + usable → `EXISTING_APPROVED_ASSET`, USD 0. Such shots are excluded from the upgrade pool.
- **Direct requests are rejected too.** If the mix requests I2V anyway, `decide()` lowers the shot back to the existing asset.
- **Replacement exception.** A replacement needs all of: `shot-contract/1.1`, `replacementRequested`, `replacementReason` and `replacementAuthorization` (T3). The Mix Engine never sets these.
- **Ocean result.** `b1-s1` and `b1-s4` are EXISTING, cost 0 and not candidates in S1, S2 and S3 (T9, T10, C13).

## D. Fix B: generative budget as a ceiling
- **Rule.** Every I2V shot needs a valid `upgradeReason`, which is also written into `reasons[]`:
  - MOTION_ESSENTIAL requires HIGH leverage;
  - HERO_VALUE requires a hero-tier, HIGH-leverage shot on I2V_HERO;
  - TIMELINE_RHYTHM_NEED requires non-LOW leverage;
  - no reason means the shot drops to its floor.
- **MEDIUM and LOW.** Neither is an automatic candidate any more. MEDIUM can only be generated for rhythm, and only if no non-generative motion exists.
- **Check.** C14 doubles the budget and verifies that no shot appears just because more budget exists.
- **Unused generative seconds:**
  - DULCE: 42 of 77 s;
  - Ocean S1: 87 of 87;
  - Ocean S2: 52 of 87;
  - Ocean S3: 87 of 87.
- **UNJUSTIFIED_GENERATIVE_UPGRADES = 0** in DULCE and in every Ocean scenario.

## E. Fix C: timeline rhythm (anti-slideshow)
- **Algorithm (deterministic).**
  1. Classify each slot's motion. Fixed V1 footage counts as live. EXISTING clips, STOCK and I2V count as live. PARALLAX counts as depth. Ken Burns / AI_STILL count as static.
  2. Find runs of static slots.
  3. A run violates the rule when it exceeds 30 s or 6 shots (provisional limits for `longform-16x9/1.1`, fixed before any run).
  4. For each violating run, choose one eligible slot. The order is: leverage, semantic risk, identity risk, expected cost, distance to the run midpoint, existing asset, id.
  5. Apply **STILL_PARALLAX first** (non-generative, USD 0 extra). I2V with TIMELINE_RHYTHM_NEED is used only if the profile forbids parallax, and only inside the ceiling.
  6. Whatever the ceiling cannot pay for is reported as `unresolved`, not bought (T8).
  7. The minimum motion density over half-overlapping windows is reported for information only.
- **DULCE timeline.** Built from the storyboard's order, seconds, origin and src only: 127 slots, 72 fixed. The human method of NEW shots is never read.
  - 1 violating run: P1-081…P1-087, 7 slots, 28.7 s, which contains N26.
  - It was broken with STILL_PARALLAX on N32 (MEDIUM, ranked before N26, which is LOW).
  - No violations remain afterwards, and no I2V was spent on rhythm. Minimum motion density is 0.29.
- **N26/N48 (regression evidence, no hardcoded IDs).**
  - V1.1 detects the run the human broke with N26, but breaks it with cheaper motion.
  - N48 is in no violating run under these limits.
  - Neither is generated. The human's "break the run" intent is met without paid generation.
- **I2V vs cheaper motion.** 1 non-generative treatment and 0 generative ones in DULCE. Ocean has 0 of each, but see NF1: Ocean rhythm is blind.

## F. DULCE comparison (in-sample)
| | clips | billed s | s/min | video USD | expected USD | worst USD |
|---|---|---|---|---|---|---|
| HUMAN_PLANNED | 13 | 70 | 7.21 | 3.50 | — | plan B 44.5 recorded |
| HUMAN_USED | 11 | 60 | 6.18 | 3.00 | — | — |
| PI_V1 | 14 | 75 | 7.72 | 3.75 | 7.27 | 30.15 |
| **PI_V1_1** | **6** | **35** | **3.60** | **1.75** | **5.27** | **28.15** |

| comparison | ∩ | PI only | human only | P | R | J |
|---|---|---|---|---|---|---|
| PI_V1 vs planned | 8 | N09 N10 N21 N27 N32 N44 | N05 N26 N33 N43 N48 | 0.571 | 0.615 | 0.421 |
| PI_V1 vs used | 7 | N09 N10 N20 N21 N27 N32 N44 | N05 N26 N33 N48 | 0.500 | 0.636 | 0.389 |
| **PI_V1_1 vs planned** | 6 | — | N01 N04 N05 N26 N33 N43 N48 | **1.000** | 0.462 | 0.462 |
| **PI_V1_1 vs used** | 5 | N20 | N01 N04 N05 N26 N33 N48 | **0.833** | 0.455 | 0.417 |

- **Selection.** PI_V1_1 selects N11, N12, N20, N35, N46 (MOTION_ESSENTIAL) and N41 (HERO_VALUE). All 6 were planned by the human.
- **What was removed.** The six V1 budget-filler shots are gone. N01 and N04 were also lost; the human used them, and they are MEDIUM (NF3).
- **N20** is "PI only" versus used solely because Runway returned no video in reality.
- **Constitution C1–C16:** 0 violations. The plan is deterministic and has 100 % reasons coverage.

## G. Ocean comparison (same inputs as V1)
| scenario | V1 gen / s / video / expected / worst | V1.1 gen / s / video / expected / worst | b1-s1, b1-s4 |
|---|---|---|---|
| S1 MEDIUM (primary) | 9 / 45 / 2.25 / 3.45 / 11.25 | 0 / 0 / 0 / 1.04 / 7.80 | EXISTING, 0, not candidate |
| S2 HIGH | 9 / 45 / 2.25 / 3.45 / 11.25 | 7 / 35 / 1.75 / 2.79 / 9.55 | EXISTING, 0, not candidate |
| S3 LOW | 0 / 0 / 0 / 1.04 / 7.80 | 0 / 0 / 0 / 1.04 / 7.80 | EXISTING, 0, not candidate |

- **Constitution C1–C16:** 0 violations in every scenario, with 0 network calls, deterministic plans and full reasons coverage.
- **S2 vs human planned:** precision 1.0, recall 0.78. The 2 "misses" are the reused b1 clips, which is correct.
- **S1:** V1.1 selects nothing, because MEDIUM never upgrades (NF3). Rhythm finds no runs because of NF1.

## H. Ocean verdict: **PASS**
The pre-registered gates hold:
- R12 regression correct;
- C1–C16 with 0 violations;
- 0 unjustified upgrades;
- deterministic plans;
- 0 network calls.

PASS means **only** that V1.1 is eligible for a single-project pilot. It does not validate selection quality:
- Ocean leverage labels are circular or missing (NF3).
- Rhythm cannot be judged on Ocean (NF1).

## I. Migration history
- **Reconciled.** 0020–0022 are restored byte-for-byte, with one variant each across all branches. `supabase/migration-manifest.json` records sha256, source, production state and dates.
- **Checksum design.** Documented only; the production table is untouched.
- **Local verification.**
  - Clean apply of 0001→0025.
  - The real apply script, rehearsed against a local mirror of the production registry, applies exactly 0023–0025 and is idempotent on re-run.
  - RLS, UNIQUE idempotency and the PI checks pass.
  - 0023–0025 are expand-only, and the worker is unaffected.
- **0023–0025: SAFE_TO_APPLY.** Preconditions: human authorization and a human-confirmed registry read. They have not been applied, and 0023–0025 stay unapplied.

## J. New findings
See `NEW-FINDINGS.md`:
- NF1: Ocean rhythm is blind to archival stills normalized as STOCK.
- NF2: OPEN_QUESTION_IDENTITY_POLICY (R04).
- NF3: MEDIUM no longer upgrades, so the leverage label decides everything (N01/N04 recall loss).
- NF4: the destructive-SQL detector misses `drop constraint`.
- NF5: the registry has no checksum and no RLS.
- NF6: the timeline covers 508.6 s of the 582.7 s master.
- NF7: README branch names corrected (docs).
- NF8: the default branch is not `main`.

## K. Next mission (exactly one)
**PI V1.1 out-of-sample SHADOW pilot on ONE new Long Form project, with zero PI spend.**
- **Labels.** Humans label `motionLeverage` and the stock media kind (clip vs still) for every shot before PI sees the project. This addresses NF1 and NF3.
- **Two planners, one spender.** The legacy planner produces and spends as usual. PI V1.1 runs in SHADOW only, never on the same project's spend (per `PILOT-GATE-V1_1.md`).
- **Comparison.** Compare PI's decisions shot by shot with the human decisions and with final QA outcomes.
- **Out of scope.** No worker connection, no migrations, no YouTube.
