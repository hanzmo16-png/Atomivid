# Proposal: CINEMATIC HISTORY / WARFARE policy for Production Intelligence

Status: proposal only. Production Intelligence V1.1 (frozen tree fb24a402…) is not modified. Written from the
VIDEO-004 Thermopylae V2 audit so the lesson is reusable, not a Thermopylae patch.

## Principles
1. QUALITY PER DOLLAR > LOWEST ABSOLUTE COST. The planner optimises perceived motion and comprehension per dollar within a cap, not spend minimisation.
2. ACTION NARRATION → ACTION VISUAL. A sentence whose verb is movement (advance, march, charge, form, wheel, fall, sail, climb, flee, surround) gets a moving picture. A still with a camera move is never its default.
3. TACTICAL / GEOGRAPHIC EXPLANATION → ANIMATED GRAPHICS FIRST. Routes, fronts, formations, numbers and timelines are deterministic animations synchronised to the words, at USD 0, before any generative call.
4. AI MOTION RESERVED FOR HIGH-PERCEPTUAL-VALUE SHOTS. Scale, formations, dust, weather, crowds at distance, equipment in wind. Not for faces, hands or close combat.
5. SOUND DESIGN IS PART OF THE VISUAL EXPERIENCE. An SFX stem with dynamics (silences, swells, impacts) is a pipeline stage, not a finishing touch.
6. STATIC IMAGE ≠ DEFAULT FALLBACK FOR ACTION. When a clip fails, the fallback order is: another approved clip, animated graphic, stock, recut, then still motion, and the fallback is recorded.

## Proposed profile `CINEMATIC_WARFARE_16X9` (additive to profiles.ts; not applied)
- generativeSecondsPerFinishedMinute: 14 (from 8), generativeSecondsCap: 240, heroQuota: 2.
- rhythm: maxConsecutiveStillSeconds 12 (from 30), maxConsecutiveStillShots 2 (from 6), motionDensityWindowSeconds 60 with a 60% floor of significant motion per window.
- allowedMethods adds ANIMATED_GRAPHIC (internal, USD 0) ranked above STILL_* in the ladder for shotClass map/graphic and for contracts flagged `explanatory`.
- qualityTier hero allowed on two shots: the hook and the climax.

## Proposed contract fields (contract.ts, versioned `shot-contract/2`)
- `narrationVerbClass`: 'action' | 'state' | 'explanation' (derived from the narration intent at storyboard time).
- `motionValue`: 'scale' | 'formation' | 'weather' | 'equipment' | 'character' | 'none' (what motion would add).
- `soundCue`: optional list of SFX intents for the sound stage.

## Proposed rules (decide.ts / mix.ts)
- R13 ACTION_NEEDS_MOTION: `narrationVerbClass === 'action'` and floor method is STILL_* → the shot enters the upgrade pool with reason MOTION_ESSENTIAL even at MEDIUM leverage; LOW leverage is still never animated.
- R14 GRAPHIC_ANIMATES: shotClass map/graphic → ANIMATED_GRAPHIC by default; a static card needs a stated reason.
- R15 QUALITY_PER_DOLLAR ranking: candidates sorted by (motionValue weight × slot seconds) / clip cost, hero shots first, then the budget ceiling applies.
- R16 ACTION_FALLBACK_ORDER as in principle 6; a documented fallback never trips the generative-set QA check.

## Proposed stages (production-core)
- `sound`: builds the SFX stem (procedural + CC0) from `soundCue`s and the timeline, with silence placement checks.
- `graphics` renders frame sequences, not single PNGs, when the contract has an animation spec.
- QA adds `motionShareAtLeast60` (warfare profile), `noStillRunOver12s`, `intentionalSilencesPresent`.

## Rollout
Document now; implement after the Thermopylae V2 delta validates the renderer and the sound stage; then version the profile and run the PI test suite before any blind-project use.
