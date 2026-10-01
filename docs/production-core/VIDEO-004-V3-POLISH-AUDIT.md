# VIDEO-004 Thermopylae — V3 polish audit (Phase 1, read-only, zero spend)

Status: **THERMOPYLAE_V3_POLISH_COST_AUTHORIZATION_REQUIRED**. V2 is immutable and was not touched. Spend this turn USD 0.00;
ElevenLabs characters consumed 0; paid generative calls 0.

## 1. Pre-flight (from the repo and the run artifacts, nothing invented)
| Item | Value |
| --- | --- |
| V2 master | `VIDEO-004-Three-Days-at-the-Hot-Gates-v2-master.mp4`, 736.8 s, sha256 `eca494aa3881204724c7a9211f7eebc08893ffb3caa3ed587fe626ba4e236b10` (run 36876459184, `videos/video-004-thermopylae/final-v2/`) |
| HEAD at audit | `5d747f20d8c1676c2bc6211485a9e2d7e837ba57` (branch claude/production-intelligence-v1); V2 render commit `01a2f911…` |
| Script | `content/productions/video-004-thermopylae/SCRIPT.md` (frozen, sha256 prefix 253650e5), 1,566 words |
| Subtitles | `video-004-v2-en.srt`, `video-004-v2-subtitles.ass` (word-highlight, 1,566 word events) |
| Narration | `videos/video-004-thermopylae/narration/S1…S9.mp3 + .json` (local copies from run 36816908381); 694.7 s; exact word alignment on all 9 scenes |
| Voice | David · `cCYjmrGZaI86GUJ7F2Nn` · `eleven_multilingual_v2` · stability 0.5 · similarity 0.75 · style 0 · speaker boost on · speed 0.92 · language en |
| Output | endpoint `/with-timestamps`, default output format → MP3 44.1 kHz 128 kbps mono (ffprobe) |
| Dictionary | `video-004-thermopylae`: 25 alias rules, hyphenated capitalised respellings (e.g. `Ther-MOP-ih-lee`) |
| End cards | V4-094 epitaph card 693.9–705.8 s (animated graphic); V4-095 Plutarch line 705.8–714.4 s (stock manuscript + subtitle); V4-099 end card 735.3–736.8 s |

## 2. Pronunciation audit (measured, not guessed)
Method: every proper name (131 occurrences, 128 after excluding "BC"/"Mount") located in the word timings; voiced span trimmed at −38 dBFS; internal pauses ≥ 90 ms detected on the 10 ms RMS envelope; speaking rate compared with the median of the same scene (chars/s). Default PASS.

**Result: 113 PASS · 2 WATCH · 13 PATCH_REQUIRED.** The user's two examples are both confirmed: *Thermopylae* at 0:44 (title) has a 120 ms internal pause and runs 2.7× slow; *Ephialtes* at 7:25 runs 2.35× slow (over-articulated, no silent gap). The other 9 occurrences of Thermopylae PASS (1.4–2.0×), so the problem is the hyphenated alias under certain prosodic positions, not the word.

| Master t | Name | Voiced | Rate | Internal pauses (ms) | Observed issue |
| --- | --- | --- | --- | --- | --- |
| 44.28 | Thermopylae | 1.77 s | 2.7× | 120 | internal pause 120 ms; 2.7x the scene speaking time for its length |
| 91.74 | Xerxes | 0.93 s | 2.6× | — | over-articulated: 2.6x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 155.92 | Artemisium | 1.76 s | 2.6× | 90 | internal pause 90 ms; 2.6x the scene speaking time for its length |
| 175.35 | Leonidas | 1.28 s | 2.4× | — | over-articulated: 2.4x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 198.94 | Thespiae | 1.98 s | 3.7× | 280, 270 | internal pause 280 ms; 3.7x the scene speaking time for its length |
| 203.57 | Phocians | 1.26 s | 2.4× | 90 | over-articulated: 2.4x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 205.02 | Locrians | 1.85 s | 3.5× | 210 | internal pause 210 ms; 3.5x the scene speaking time for its length |
| 358.96 | Demaratus | 1.33 s | 2.4× | — | over-articulated: 2.4x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 418.90 | Dienekes | 1.16 s | 2.4× | — | over-articulated: 2.4x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 445.72 | Ephialtes | 1.29 s | 2.4× | — | over-articulated: 2.4x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 520.48 | Thespians | 1.60 s | 2.8× | — | over-articulated: 2.8x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 568.00 | Leonidas | 1.33 s | 2.6× | — | over-articulated: 2.6x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |
| 636.37 | Artemisium | 1.87 s | 2.9× | — | over-articulated: 2.9x the scene speaking time for its length (no internal pause detected; hyphenated alias read as separate pieces) |

WATCH (no patch): Mycenae 3:16 (2.3×), Xerxes 10:21 (2.3×). Everything else, including all 10 Herodotus, 12 Greeks/Greek, 9 Spartans/Sparta, Hellespont, Hydarnes, Anopaea, Cissians, Carneia, Plataea, Marinatos, Simonides, Plutarch, Salamis, Acropolis: PASS.

Root cause (evidence): every flagged word is a dictionary alias written as `Syl-LA-ble` with hyphens and capitals; the model reads the pieces as separate tokens. Non-alias names never fail.

## 3. Pronunciation manifest (11 segments, 1,305 characters)
Full detail in `v3/pronunciation-manifest.json` (display_text, tts_text, previous/next context, target IPA, strategy, deltas). display_text is always the canonical spelling; subtitles never change.

| Seg | t | Names | Chars | Name time now → est. | Sentence |
| --- | --- | --- | --- | --- | --- |
| P01 | 44.28 | Thermopylae | 76 | 1.77 → 0.86 s (-0.91) | It is a harder story than the legend. And a better one. This… |
| P02 | 91.74 | Xerxes | 85 | 0.93 → 0.47 s (-0.46) | Herodotus says that when a storm broke the first bridges, Xe… |
| P03 | 155.92 | Artemisium | 154 | 1.76 → 0.87 s (-0.89) | Block the land road into central Greece at Thermopylae, and … |
| P04 | 175.35 | Leonidas | 156 | 1.28 → 0.70 s (-0.58) | So Sparta sent an advance guard: one of its two kings, Leoni… |
| P05 | 198.94 | Thespiae, Phocians, Locrians | 215 | 5.09 → 2.09 s (-3.00) | On the road north, the allies joined: men from Tegea and Man… |
| P06 | 358.96 | Demaratus | 120 | 1.33 → 0.71 s (-0.62) | A Spartan exile at the king's court, Demaratus, explained: t… |
| P07 | 418.90 | Dienekes | 92 | 1.16 → 0.63 s (-0.53) | Before the battle, a Spartan named Dienekes was told that Pe… |
| P08 | 445.72 | Ephialtes | 199 | 1.29 → 0.71 s (-0.58) | The Persians attacked in relays; the Greeks rotated city by … |
| P09 | 520.48 | Thespians | 64 | 1.60 → 0.73 s (-0.87) | The seven hundred Thespians, under Demophilus, refused to le… |
| P10 | 568.00 | Leonidas | 57 | 1.33 → 0.65 s (-0.68) | The spears broke. They fought with swords. Leonidas fell.… |
| P11 | 636.37 | Artemisium | 87 | 1.87 → 0.83 s (-1.04) | The same three days, the fleets had been fighting off Artemi… |

Every estimated delta is negative (names will get shorter): absorbed as silence inside the same slot, so cuts, maps and music keep their frames. TIMING_BLOCKER only if a regenerated sentence comes back longer by more than 150 ms after atempo ≤ 1.03.

## 4. ElevenLabs lock
voice_id `cCYjmrGZaI86GUJ7F2Nn`, model `eleven_multilingual_v2`, stability 0.5, similarity 0.75, style 0, speaker boost on, speed 0.92, output MP3 44.1 kHz 128 kbps, `with-timestamps`, same dictionary id (new version with rewritten aliases). Priority: (1) dictionary alias as plain lowercase respelling, (2) previous_text/next_text context, (3) controlled respelling in tts_text only, (4) SSML/phoneme not used: not assumed supported on multilingual_v2; the gate run will record what `GET /v1/models` reports.

## 5. Dry pronunciation gate — DRY_GATE_READY_FOR_AUDIO_TEST (no audio generated)
| Sample | Name | Chars | tts_text |
| --- | --- | --- | --- |
| G1 | Thermopylae | 76 | It is a harder story than the legend. And a better one. This is thermopilee. |
| G2 | Ephialtes (+Trachis) | 98 | And then, that evening, a local man came to the king's tent. His name was efialtees, from trakis. |
| G3 | Thespiae / Phocians / Locrians | 215 | On the road north, the allies joined: men from Tegea and Mantinea, Corinth, Phlius, myseenee, seven hundred from thespie… |
Total 389 characters ≈ USD 0.078, each with previous_text/next_text context. Nothing is corrected until a human hears these.

## 6. Future audio patch plan (not executed)
Per segment: generate the whole sentence (or the sentence group) with context; align words; measure loudness (match ±0.5 LU to the surrounding scene audio); replace the exact span in the scene file with 30 ms crossfades at word boundaries; pad with silence when shorter; atempo 0.97–1.03 only if longer; re-run alignment and the narration validation; then re-render V3 from the unchanged V2 timeline logic. No name is ever generated in isolation.

## 7. End cards — findings (not fixed)
**Finding A (systemic, V2 defect):** `renderAnimatedSegment` renders every animated SVG through sharp at density 96 → 3072×1728 px, but extracts the drift window with 2304×1296 coordinates. Result: all 17 animated graphics show only the top-left 75% of the canvas, enlarged 1.33×. Reproduced locally (`v3audit/epitaph-v2frame.png`).
- V4-094 epitaph card (11:34–11:46): card box lands at x 416–2656 of a 2304-wide window → right 13% clipped; the Greek line ends at "τῇδ"; the box bottom (y 1333 of 1296) clipped; attribution "Simonides · Herodotus 7.228" at y 1240 inside but the subtitle band (y 896–1016 in 1080p) overlaps the English lines. Safe-area violations: right and bottom.
- V4-099 end card: credits lines (2 × 26 px, centred at x 1152) lose their right end; title and channel stay inside.
- All maps: labels on the right (Sardis, Hellespont, "Persian fleet", Doriscus) and bottom (contingent labels, captions) fall outside or on the edge; the hoplite kit shows only shield and spear; the Persian-kit callouts (composited on the 1920×1080 still, not through this path) are correct.
- V4-095 Plutarch line: stock manuscript + subtitle; no box; the subtitle "“Come and take them”," wraps correctly inside the 160 px margins. No defect.
**Fix (V3, USD 0):** render the SVG at its native 2304×1296 (density 72 or explicit resize) before extracting; keep the works untouched, correct the container only. Then QA: NO_TEXT_OUTSIDE_SAFE_AREA (96/54 px), NO_IMAGE_OUTSIDE_FRAME, NO_OVERLAP with the subtitle band (reserve y > 880 for subtitles: move the epitaph card up 60 px or shorten it), NO_CLIPPED_QUOTE, NO_CLIPPED_ATTRIBUTION, implemented as a contact-sheet of every animated graphic at 25/50/75/100% with the safe-area rectangle drawn, plus an automatic check that the SVG text bounding boxes (from the SVG geometry) stay inside the safe area.

## 8. CTA #1 — post-hook (design only)
- Timestamp: **50.0 s**, the first clean boundary after the hook pays off: the title ("This is Thermopylae.") ends at 44.3 s, the title card holds to 50.0 s, and S2 opens with "Ten years earlier…". Inside the 45–90 s target, interrupts no payoff.
- Exact line (English, same voice): **"If you want more history told this carefully, subscribe. Now, back to the pass."** (15 words, ≈ 6.5 s at the narration's measured pace, 79 characters).
- Visual: the approved sunrise-pass clip V4-002 slowed to cover 6.5 s (motion continues, no black), with a small animated lower-third "Subscribe · Earthward Chronicles" mark (free SVG, 2 s fade), music bed continuing under; subtitles in the normal style.
- Integration: inserted as a new scene between S1 and S2; every later slot shifts by the same 6.5 s, so maps, music sections and SFX stay in sync (all cues are slot-relative). Narration cost ≈ USD 0.016.

## 9. CTA #2 — final (design only)
- Timestamp: **735.3 s**, after the last sentence ("…and the arrowheads were still in it.") and before the end card; the epitaph card and the Plutarch beat (11:34–11:54) are untouched.
- Exact line: **"If this stayed with you, subscribe and turn on notifications. The next one is already on its way."** (17 words, ≈ 7 s → trimmed read at ~6 s, 98 characters).
- Visual: the approved golden-hour islands stock V4-093 (9 s available) with the subscribe mark and a bell icon fading in, music resolving; then the existing end card (1.5 s). No black screen until the end card.

## 10. CTA engine proposal (documentation only, video-004 scope)
CTA_MODE OFF | SUBTLE | STANDARD. SUBTLE = one post-hook CTA + one final CTA (this title). STANDARD adds an optional mid-video visual-only CTA. Principle: HOOK FIRST → VALUE → CTA; language, tone and placement derived from the narration; no CTA before the hook pays off; never over a quote/epitaph beat. No renderer, PI, default or schema changes.

## 11. Cost audit (no spend)
| # | Item | Value |
| --- | --- | --- |
| 1 | Names audited | 128 occurrences (131 incl. BC/Mount) |
| 2 | PATCH_REQUIRED | 13 occurrences |
| 3 | TTS segments | 11 pronunciation + 2 CTA = 13 |
| 4 | Gate characters | 389 |
| 5 | Full-patch characters | 1,305 (pronunciation) + 176 (CTAs) = 1481; with one retake allowance ≈ 2,100 |
| 6 | ElevenLabs capacity (read-only GET, run 36876459184) | 20,623 characters remaining of 63,002, reset 2026-10-16 |
| 7 | Gate cost | USD 0.078 (389 × 0.0002) |
| 8 | Full patch cost | USD 0.296 expected, USD 0.42 with retakes |
| 9 | Other costs | USD 0 (end-card fix, safe-area QA, CTA graphics, re-render, proxy: FFmpeg/sharp on the runner) |
| 10 | Projected V3 incremental | USD 0.374 expected, hard max proposed USD 0.60 → cumulative 16.83 → ≈ 17.13 (cap 19 untouched) |

## 12. Two separate authorizations (proposed, not executed)
**GATE AUTHORIZATION:** generate only the 3 gate samples (G1–G3), max 450 characters, max USD 0.09, same voice settings, one attempt each, nothing else changes; output: three MP3s + alignment for human listening. Status after: human verdict required.
**FULL PATCH AUTHORIZATION (only after the gate is approved by ear):** the 11 segments + 2 CTAs, max 2,100 characters, max USD 0.42, end-card container fix, safe-area QA, V3 render and review proxy; TIMING_BLOCKER stops the render if any segment cannot be fitted.
