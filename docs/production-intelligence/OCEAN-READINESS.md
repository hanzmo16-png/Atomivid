# OCEAN / OCÉANO — Production Intelligence V1 readiness (no production, no spend)

Source of truth: `origin/codex/ocean-opening-review` @ `5427188` (most advanced; `codex/dulce-pilot` adds only DULCE commits on top). This branch (`claude/production-intelligence-v1`) does not contain the Ocean data; `.github/workflows/long-form-ocean.yml` pins `ed971e73` with `DATA_BRANCH=codex/ocean-opening-review`.

## What exists
- Script v002 (`content/long-form/ocean-deep-001/ocean-script-001.json`): English, 7 beats, 1,870 words, 22 sources, claims tagged fact/uncertainty/inference. Narrated with **Brian** (`eleven_multilingual_v2`), 658.1 s, cached per beat in Storage `ocean-deep-001/samples/episode` (not in git); word timings in `episode-inputs/`.
- Storyboard `ocean-storyboard-001.json` (meta v003, 84 shots) and episode manifest `docs/quality/ocean-deep-001/episode-manifest.json` (**111 scenes, all approved**; noaa-video 70, graphic 20, veo-clip 8, pexels-video 6, existing 4, commons 3), 15 sound cues, word-highlight captions.
- Reviews: NOAA candidate lists, `selected-archive-review.json` (16 sources with windows/limitations), `perceptual-review.json` (132 duplicate adjudications).
- Renders only as Actions artifacts (stage A first minute, motion check, full PREPARE_OK). **No verified final master or delivery found.**
- Spend (PLAN.md §13.6): spent USD 13.36 (voice 3.21 + images/clips 10.15); committed incl. one Veo 429 attempt USD 14.32 of the USD 17.65 cap. Ledger JSON lives in Storage, not in git.

## Contracts: what maps and what is missing
Mechanically derivable from the manifest (+ storyboard): shotId, shotClass (from source kind/provenance), narrationIntent, desiredDuration, maxGeneratedDuration (Veo 8 s), motionRequirement (motion/camera), existingApprovedAssetId (approved NOAA/Veo/paths), stockAvailable (NOAA/Pexels/Commons), riskClass (partial: ai_recreation + limitation notes), continuityGroup (beat).
Missing: requiredEntities, forbiddenElements (only free text in prompts), characters, **motionLeverage**, qualityTier, humanIntervention (implied by reviews; it is `human`).
**Storyboard migration needed:** there is no join key between storyboard ids (`b1-s1`, 84) and manifest ids (`episode-bX-NN`, 111). Build a mapping (by beat + time overlap), then a converter manifest → Shot Contracts with an explicit, reviewed `motionLeverage` per scene (the one judgment the engine cannot infer).

## Reusable QA
`perceptual-confirmation.ts` (dHash + SSIM/MAE duplicate confirmation), perceptual adjudication in `long-form-quality-sample.ts`, `scripts/lib/contact-sheet.ts`, `noaa-video.ts` excerpt rules, license review blocks. These become QA executors feeding `qa-gate.ts`; none needs rewriting. Note: this branch lacks `perceptual-confirmation.ts`, `noaa-video.ts`, `ocean-sounds.ts`, `OceanScientificDiagram.tsx` — they must be merged from the Ocean branch first.

## Known risks
- Mostly archival footage: licensing is "public domain unless otherwise marked" (NOAA) and some shots are illustrative, not literal (USGS vents, ROV-lit animals) — keep provenance labels.
- Three generated clips carry accepted defects; one Veo attempt hit quota (429) → still. Veo, not Runway, produced these; mixing providers requires provider-specific memory cells.
- Narration is **Brian**; changing voice would re-spend TTS (voice quota ≤ 1,084 characters left then).
- Outputs only in expiring Actions artifacts; the master must be delivered with the single-file policy (500 MB).
- Budget: USD 3.33 of the old cap remains; a new PI reservation must start from the committed ledger, not from zero.

## Old pipeline vs PI V1 — comparable data
Old: USD 1.30/finished minute committed (≈ 0.92 cash), 10 Veo clips + 10 AI stills, 1 provider failure, 132 duplicate adjudications, 4 re-trimmed windows (PLAN.md §8–13, storyboard meta `paidItemsUsd/veoClips/veoBillableSeconds`). PI V1 run in shadow on the converted contracts would report: planned generative seconds vs budget (8 s/min → ~87 s for 10.9 min), expected vs worst-case reservation, rule-driven downgrades, and — after delivery — cost per approved shot / per finished minute from telemetry. Missing for a fair comparison: the Storage ledger export, a structured reject log, engineering time.

## Next steps (when authorized)
1. Merge the Ocean data/code branch into a PI branch (no spend). 2. Write the manifest → contract converter + motionLeverage review. 3. Run PI in **shadow** over Ocean (zero cost) and compare with the shipped plan. 4. Only then decide whether Ocean's remaining work (master render + delivery) runs through PI.
