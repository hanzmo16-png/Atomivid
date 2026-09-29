# BLIND-PROJECT-001-PROTOCOL (`blind-protocol/001.1`)

This protocol sets up the first blind out-of-sample test of **Production Intelligence V1.1** (`policy/1.1.0-candidate`, engine tree `fb24a402…a2cbef`).
- **Project:** The Iron Annals (@TheIronAnnals), candidate EPISODE #001.
- **Topic:** `EPISODE_TOPIC = PENDING`. The candidates are Thermopylae/Leonidas, Pompeii and the Fall of Constantinople 1453.

`protocol.json` is the binding version and is locked by hash in `PROTOCOL-LOCK.json`. If the file changes, the CLI refuses to seal, run the shadow or evaluate. A new protocol requires a new version and a new blind project. This page summarizes the protocol; the JSON wins if they ever disagree.

## Mandatory order
1. TOPIC SELECTED (by the user)
2. RESEARCH
3. SCRIPT
4. HUMAN STORYBOARD
5. HUMAN PRODUCTION DECISIONS
6. **HUMAN BASELINE SEALED**
7. PI V1.1 SHADOW
8. COMPARE
9. PRODUCTION
10. FINAL QA
11. BLIND TEST RESULT

PI cannot run before step 6. The harness enforces this: `runShadowGated` throws `ShadowGateError`, as do the CLI `shadow` command and the tests. Research may use the web, LLMs and other sources. That is editorial work, not PI.

## Unit of analysis
One shot of the sealed human storyboard, meaning one timeline position.

## Human shot contract
Every field is required. `UNKNOWN` is not allowed, so the seal refuses an incomplete baseline. The fields fall into two groups.

**PI input**, the allowlist PI may see:
- `shotId`, `timelineOrder`, `duration`
- `narrationIntent`, `visualIntent`, `shotClass`, `sourceType`, `characters`
- `identityCritical`, `multiHuman`, `complexHands`
- `motionRequirement`, `motionLeverage`, `riskClass`, `qualityTier`
- `existingAsset`, `existingAssetApproved`, `existingAssetKind`
- `continuityGroup`, `previousState`, `nextState`

**Human answer**, which PI never receives:
- `motionJudgment`: MOTION_ESSENTIAL, BENEFICIAL or UNNECESSARY
- `humanPreferredMethod`, `humanWouldGenerateVideo`, `humanReason`
- `adequateMethods`
- `cheaperMethodSufficient`, `generationRiskUnacceptable`
- `i2vPlan`: why, duration, expected provider and estimated cost; required exactly for I2V shots

**Source types.** A still is never treated as motion, which fixes Ocean NF1:

| sourceType | how PI sees it |
|---|---|
| `STOCK_PHOTO`, `ARCHIVAL_PHOTO`, `AI_STILL`, `OTHER` | a still (`stockAvailable=false`) |
| `STOCK_VIDEO`, `ARCHIVAL_VIDEO` | moving footage |
| `GRAPHIC` | only valid with shotClass `graphic` |
| `MAP` | only valid with shotClass `map` |
| `EXISTING_APPROVED_ASSET` | needs an approved `existingAsset` |

Known limitation: for photo-based floors, PI's cost includes an AI-still price, so its cost estimate for those shots is conservative. This is reported and never corrected after the run.

## Seal
The seal stores:
- `baselineId`, the git commit SHA and the timestamp;
- sha256 hashes of the whole baseline, of the shot inputs, of the human answers, and of the research, script and storyboard files;
- the number of shots, planned generative clips, planned generative seconds, planned seconds per minute and expected cost.

After sealing:
- `HUMAN_BASELINE_SEALED = true`.
- The object is deep-frozen, and `verifySeal` detects any later edit.
- Corrections go through `amend`: an append-only chain where each entry links to the previous hash. Scoring always uses the **original** sealed answers, and amendments are reported separately.

## Shadow gate (implemented in the harness; PI V1.1 is not modified)
The shadow refuses to run if any of these checks fails:
- the baseline is sealed;
- the seal verifies;
- the protocol hash equals the one recorded at seal time;
- the policy, profile, contract, rate card and memory versions equal the pre-registered ones;
- the engine tree hash equals the pre-registered one.

The shadow run itself works as follows:
- PI receives a structural projection containing only the allowlisted fields.
- `assertNoLeak` rejects any answer key, and any human free-text answer, found in the PI input.
- `fetch` throws for the whole run. Any call is counted and fails the test.
- Results are written once and never regenerated.

## Metrics (fixed now)
- **Selections.** HUMAN_SELECTED and PI_SELECTED count I2V_ECONOMY and I2V_HERO shots.
- **Overlap.** Intersection, PI_only and human_only. Precision is 1 when PI selects nothing, recall is 1 when the human selects nothing, and Jaccard is 1 when both select nothing.
- **Volume.** Generative clips, generated seconds and seconds per minute, for both the human and PI.
- **Cost.** Human expected cost is the sum of `i2vPlan.estimatedCostUsd`. PI reports expected cost, video expected cost (seconds × USD 0.05) and worst-case reserved cost.
- **EXPENSIVE_FALSE_POSITIVE.** PI generates and the human does not, and at least one of these holds: the human judged motion UNNECESSARY, a cheaper method is sufficient, or generation risk is unacceptable. An **unsafe** one is the case where generation risk is unacceptable.
- **QUALITY_FALSE_NEGATIVE.** The human judged motion ESSENTIAL, and PI's method is not in `adequateMethods`.
- **ALTERNATIVE_GOOD_DECISION.** The human would generate and PI does not, and all of these hold:
  - PI's method is in `adequateMethods` (it carries the claim);
  - the shot is in no unresolved PI rhythm run (the rhythm need is met);
  - PI's expected cost is at most the human's estimated cost;
  - PI's method is non-generative, so the risk is not higher.

  This is **not** an error.
- **DISAGREEMENT.** Any other difference. It is reported, never scored as an error.
- **UNJUSTIFIED_GENERATIVE_UPGRADE.** A PI generative shot without a valid `upgradeReason` written in `reasons[]`.

## Constitution
C1–C16 of PI V1.1, including:
- no repurchase of approved assets;
- the budget is a ceiling;
- every I2V has an `upgradeReason`;
- non-generative motion comes first for rhythm;
- the shadow makes zero provider calls.

A single violation means **FAIL**.

## Verdict (fixed before the topic)
- **FAIL** if any of these occurs:
  - a constitutional violation;
  - a network call;
  - an unjustified upgrade;
  - the budget or reservation is exceeded;
  - an automatic repurchase;
  - non-determinism;
  - reasons coverage below 100 %;
  - one or more UNSAFE_EXPENSIVE_FALSE_POSITIVE;
  - two or more QUALITY_FALSE_NEGATIVE.
- **INCONCLUSIVE** (when there is no FAIL) if any of these holds:
  - fewer than 30 shots;
  - fewer than 3 MOTION_ESSENTIAL shots;
  - neither the human nor PI selects any generation;
  - in the final stage, the post-production UNKNOWN share is above 0.2.
- **PASS** otherwise. There is **no minimum Jaccard**: PI may be different from, or better than, the human.

A PASS means PI may be *considered* for a controlled production pilot. It never authorizes spend by itself.

## Post-production truth and user acceptance
After the authorized production, record per shot:
- `FINAL_USED_METHOD`;
- where possible, `userKept`, `userRequestedRegeneration` and `userReason`.

This gives a third comparison: HUMAN_BASELINE vs PI_SHADOW vs FINAL_MASTER.
- If the human changes their mind during production, it is recorded as `humanChangedMind`. The baseline is never rewritten.
- UNKNOWN values are excluded from denominators and counted separately.
- These records are evidence only; nothing changes PI automatically.
