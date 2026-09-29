# PI V1 — Failure analysis (exam of 2026-09-29, frozen d1330e7)

Nothing in PI was changed. PI V1.1 below is a **CANDIDATE** hypothesis; it must go back to Shadow.

## F1 — Re-purchase of approved, already-paid assets (Ocean) — decides the FAIL
- **Rule that failed:** the ladder principle "EXISTING_APPROVED_ASSET first" is applied to the floor, but the Mix Engine's upgrade-candidate filter only checks leverage and motion requirement. `decide()` has no rule that forbids a generative upgrade for a shot whose floor is an existing approved asset.
- **Shots:** Ocean `b1-s1`, `b1-s4`. Storyboard v003: *"REUSED from the approved first minute (already paid / already cleared) — no new cost"*. PI (S1 and S2) selects `I2V_ECONOMY` for both.
- **Why:** `existingApprovedAssetId` sets the floor, then `planMix` requests `I2V_ECONOMY` and nothing blocks it.
- **Economic impact:** USD 0.66 expected / USD 1.70 worst case here; it scales with every project that reuses approved footage (every Ocean manifest scene is approved, so a later pass would expose all MEDIUM/HIGH shots).
- **Quality impact:** replaces an approved, QA-passed clip with an unreviewed one.
- **Hypothesis V1.1:** a contract with `existingApprovedAssetId` (or `stockAvailable` for motion that the footage already carries) is never an upgrade candidate unless the contract explicitly marks the existing asset as insufficient.

## F2 — The generative budget behaves as a quota, not a ceiling (DULCE, in-sample)
- **Shots:** N09, N10, N21, N27, N32, N44 (6 of 7 PI-only). The human audit wrote, for these same shots, that camera motion was enough: "a slow pan is enough", "a push-in gives the vertigo", "push plus an FFmpeg glow pulse", "a lateral pan … reads as departure", "a push-in carries the warning".
- **Why:** every MEDIUM + motion-required shot is a candidate; allocation continues until the 77 s budget is used (75/77 s).
- **Economic impact:** +6 clips vs the human selection, USD 1.50–1.98 expected video (+ stills), all inside budget.
- **Quality impact:** unknown (never produced); risk exposure grows with each extra generation.
- **Hypothesis V1.1:** MEDIUM leverage upgrades only when the contract states that camera motion cannot carry the claim (a new explicit contract field), or MEDIUM gets a sub-budget; HIGH keeps priority.

## F3 — Missing timeline-structure criterion (DULCE)
- **Shots:** N26, N48 (LOW leverage), animated by the human B+ pack "to break runs of consecutive stills". PI has no notion of adjacency, so it never upgrades them.
- **Hypothesis:** a deterministic "max consecutive still-motion seconds" constraint in the Mix Engine (profile parameter), evaluated on the timeline order.

## F4 — R04 is conservative (DULCE)
- N05 and N33 (identity-critical, MEDIUM/LOW) were generated and passed QA in reality; R04 kept them still. N43 (same rule) failed identity QA in reality — R04 was right there. 1 true positive, 2 false negatives in-sample. No change proposed without out-of-sample evidence.

## Measurement caveats
- DULCE is in-sample: motion leverage values come from the same human audit that chose Smart Mix B+.
- Ocean S1/S2 agreement (Jaccard 1.0) is **circular**: the only non-LOW shots are `AI_RECREATION`, a storyboard label that already encodes the human decision to animate. S3 (all LOW) selects nothing. PI's selection quality cannot be judged on Ocean without independently labelled leverage.
