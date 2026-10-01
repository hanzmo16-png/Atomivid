# Video #004 — Three Days at the Hot Gates (Thermopylae) · Final Cut candidate

Status: **READY_FOR_HUMAN_FINAL_CUT_REVIEW**. Not published. Produced from frozen package 916059ce (commit c227517)
under the USD 20 hard cap; final render run 36821933646 (request 07).

## Master
- File: `VIDEO-004-Three-Days-at-the-Hot-Gates-master.mp4` · 470.7 MB · sha256 `d9101587a127df1c79483026564014ed1abf9ebd0a7b33f0d825d372ecdb8510`
- 1920x1080 · 30/1 fps · h264 · 736.8 s (12.3 min)
- Loudness -14 LUFS integrated · true peak -3.2 dBTP · LRA 3.4 LU
- Storage: `videos/video-004-thermopylae/final/` (45 MB parts + manifest), HLS watch copy under `watch/hls/` (signed link kept out of git; expires 7 days after the run)
- Direct MP4: GitHub Actions artifact of run 36821933646 (30-day retention)

## Technical QA: 17/17 PASS
durationNearPlan, durationInTarget, resolution1080p, fps30, h264, audioStereo, noAccidentalBlack, noFrozenPicture, noSilentGaps, loudnessNear14, truePeakSafe, allSlotsSourced, noPlaceholders, subtitlesCoverAllWords, hookAtLeast8Changes, noHeldFrames, frozenGenerativeSetHonoured

## Cost (ledger, measured)
| Provider | USD |
| --- | --- |
| ElevenLabs (narration, 8,883 characters) | 1.7766 |
| OpenAI (54 stills incl. 8 retakes) | 3.8029 |
| Runway (14 clips: 5 × 5 s, 9 × 10 s; one retry) | 5.7500 |
| **Total** | **11.3295** (expected 11.23, hard cap 20.00; variance +0.10) |

Paid operations 77, released claims 1 (one Runway task ended without output; refunded, not billed),
retries 9 (USD 0.97: 8 still retakes at the corrected prompts, 1 simplified clip retry).

## Mix
- Generative clips in the master: 13 (91.4 s, 12.4% of runtime), one documented clip fallback (V4-055: arrow flight degraded into noise; approved still with camera motion used instead, no retry spend)
- Still-motion slots 57 (incl. 16 deterministic graphics), stock slots 29 (8 rejected stock shots replaced by labelled reconstruction stills)

## Editorial review record
- Source check (SOURCE-CHECK.md): no narrated sentence contradicts Herodotus 7; two translation-level qualifications noted.
- Stills: 46 generated + 8 fallback; 8 retaken once with explicit corrections (medieval battlements, Greek figures in Persian scenes, figures where none belong); every used still PASS with recorded sha256.
- Stock: 37 searched, 12 rejected (modern vehicles, crowds, wrong civilisation, duplicates), 4 replaced by re-search, 8 by stills.
- Clips: 13 PASS, 1 FAIL (fallback), 1 provider failure retried once with a simplified prompt (PASS).
- Narration: exact word alignment on all 9 scenes; aliases applied for 25 Greek/Persian names (human ear check still advised).
- Known deviations from frozen durations: 5 slots differ by more than tolerance because the narration runs longer/shorter than the 150 wpm plan (largest: the allies list, 21 s on the map).

## Not done / for the human reviewer
- Listen for pronunciation of Thermopylae, Leonidas, Ephialtes, Dienekes, Demophilus, Anopaea.
- Judge the AI battle clips at full speed (slowed up to 1.5x in slots longer than the clip).
- Confirm the on-screen notice wording and the Theban note.
- Publishing is not authorised and nothing has been uploaded anywhere public.
