# VIDEO-004 — Thermopylae V3 Final Cut (final polish)

Status: **THERMOPYLAE_V3_READY_FOR_HUMAN_REVIEW** (2026-10-01). Authorised scope: 8 remaining
PATCH_REQUIRED segments + G1–G3 integration, CTA #1 and #2, the 3072/2304 geometry fix with a
single frame contract, safe-area/layout correction, subtitle re-alignment, sound continuity around
the patches, V3 render, full QA, mobile review through Review Delivery. V1, V2, the freeze, the
storyboard rows, the voice, the approved clips and the maps' content are untouched.

## Master

| Item | Value |
|---|---|
| File | `VIDEO-004-Three-Days-at-the-Hot-Gates-v3-master.mp4` (storage `final-v3/`, 45 MB parts + manifest) |
| sha256 | `86c128870dfeb2e56ec54129da9a3b694e6715b5464b4da1ddb14c04fd7dfc46` |
| Bytes / duration | 549,168,356 / 751.20 s (V2: 736.8 s; +14.4 s = CTA #1 5.07 s + CTA #2 9.63 s, minus nothing) |
| Format | 1920×1080, 30 fps (22,536 frames, exact), H.264 yuv420p, AAC 48 kHz stereo, faststart |
| Loudness | −14.0 LUFS integrated, true peak −1.8 dBFS, LRA 3.7 LU |
| V2 master | `eca494aa…6b10` verified before and after the render: intact |
| Render run | GitHub Actions 36938045746 (commit a3931d3), QA 24/24 checks PASS |

## Pronunciation patches (gate-approved strategy, 11/11 applied)

Same voice `cCYjmrGZaI86GUJ7F2Nn`, `eleven_multilingual_v2`, stability 0.5 / similarity 0.75 /
style 0 / speed 0.92, MP3 44.1 kHz 128 kbps; whole sentences with previous_text/next_text as
API context; the shared pronunciation dictionary excluded from these calls; tts_text plain
lowercase respellings; display_text (subtitles) canonical. G1→P01, G3→P05, G2→P08 (last two
sentences) reused verbatim; 8 segments generated once (no retries) in run 36917344334; the fit
re-run 36919206086 made zero calls. Each patch replaced exactly its sentence span in the V2 scene
stem: loudness matched to the surrounding narration, 30 ms fades at the joins, room tone from the
scene's own pause where the new sentence is shorter, atempo ≤ 1.03 and the neighbouring pauses
(≥ 100 ms) where it is longer. Every word after a patched span keeps its V2 timing to the ms.

| Seg | Scene | Names | Source | Original span | Patch (fitted) | Rate | Room tone | Pauses used | Gain |
|---|---|---|---|---|---|---|---|---|---|
| P01 | S1 | Thermopylae | G1 | 10.40 s | 6.53 s | 1.000 | 3.91 s | trail 0.00 / lead 0.00 | +0.5 dB |
| P02 | S2 | Xerxes | tts-stored | 6.62 s | 5.25 s | 1.000 | 1.47 s | trail 0.00 / lead 0.00 | +0.6 dB |
| P03 | S3 | Artemisium | tts-stored | 12.12 s | 9.80 s | 1.000 | 2.43 s | trail 0.00 / lead 0.00 | +0.6 dB |
| P04 | S3 | Leonidas | tts-stored | 12.95 s | 13.52 s | 1.030 | 0.00 s | trail 0.20 / lead 0.27 (100 ms rule) | +0.9 dB |
| P05 | S3 | Thespiae, Phocians, Locrians | G3 | 20.80 s | 17.16 s | 1.000 | 3.74 s | trail 0.00 / lead 0.00 | +1.5 dB |
| P06 | S5 | Demaratus | tts-stored | 9.18 s | 7.84 s | 1.000 | 1.45 s | trail 0.00 / lead 0.00 | +0.0 dB |
| P07 | S5 | Dienekes | tts-stored | 6.72 s | 6.85 s | 1.030 | 0.00 s | trail 0.02 / lead 0.00 | +1.1 dB |
| P08 | S6 | Ephialtes | G2 | 8.70 s | 7.89 s | 1.000 | 0.91 s | trail 0.00 / lead 0.00 | +0.3 dB |
| P09 | S7 | Thespians | tts-stored | 6.33 s | 5.25 s | 1.000 | 1.18 s | trail 0.00 / lead 0.00 | +1.3 dB |
| P10 | S7 | Leonidas | tts-stored | 5.68 s | 5.86 s | 1.030 | 0.00 s | trail 0.06 / lead 0.02 | +2.2 dB |
| P11 | S8 | Artemisium | tts-stored | 6.91 s | 6.11 s | 1.000 | 0.86 s | trail 0.00 / lead 0.00 | +1.3 dB |

P04 needed the audit's 150 ms rule (sentence 80 ms too long after atempo 1.03): the pauses before
and after were used down to 100 ms. No TIMING_BLOCKER remained. Subtitles and word highlighting
were rebuilt from the patched stems' alignments (no stale timings).

## CTA

| CTA | Start | Length | Picture | Line |
|---|---|---|---|---|
| #1 post-hook | 49.70 s (0:49.7), right after the title beat holds | 5.07 s | V4-092 present-day pass aerial (approved stock, reused), subscribe mark fades in top-right inside the safe area, music bed continues, subtitles normal | "If you want more history told this carefully, subscribe. Now, back to the pass." |
| #2 final | 740.07 s (12:20.1), after "…the arrowheads were still in it." and the epitaph/Plutarch beats, before the end card | 9.63 s | V4-093 golden-hour islands (approved stock, reused), subscribe + bell mark, music resolving | "If this stayed with you, subscribe and turn on notifications: the next documentary is already on its way." |

No black screen, the picture never stops; the Plutarch and epitaph beats are untouched.

## The 17 animated graphics

Root cause fixed in one place: the SVG canvas (2304×1296) is rendered at its native 72 dpi
(V2 used density 96 → 3072×1728 and cropped with 2304-based coordinates: top-left 75%, enlarged
1.33×). Single frame contract: canvas → drift crop → 1920×1080; maps fit their body above the
subtitle band; the shared caption sits inside the safe area above the band; edge/band labels
moved (pass schematic, hoplite kit, phalanx, Anopaea, allies: off-box contingents hidden,
Thebes label below its marker; Persian-kit callout flips left at the right edge).

Composed-frame QA on the master (not the SVG): text bbox from a with/without-text diff, safe area
96/54, subtitle band (y ≥ 880 px), pixel match against the pipeline render at mid-slot.

| Graphic | Kind | Text bbox (px) | Safe | Clear of subtitles | Composed match |
|---|---|---|---|---|---|
| V4-016 | map-route | [434, 176, 1389, 848] | PASS | PASS | PASS (4.81) |
| V4-019 | numbers | [157, 149, 1792, 848] | PASS | PASS | PASS (2.44) |
| V4-023 | map-league | [449, 492, 1468, 848] | PASS | PASS | PASS (2.37) |
| V4-026 | map-plan | [461, 109, 1456, 848] | PASS | PASS | PASS (2) |
| V4-030 | map-allies | [485, 123, 1432, 848] | PASS | PASS | PASS (2.5) |
| V4-033 | map-pass | [112, 71, 1806, 848] | PASS | PASS | PASS (3.38) |
| V4-038 | hoplite-kit | [256, 325, 1807, 848] | PASS | PASS | PASS (1.71) |
| V4-040 | phalanx | [523, 152, 1810, 852] | PASS | PASS | PASS (6.36) |
| V4-041 | no-flank | [226, 151, 1527, 848] | PASS | PASS | PASS (3.91) |
| V4-042 | still-callouts | [1032, 73, 1530, 781] | PASS | PASS | PASS (10.31) |
| V4-058 | map-anopaea | [113, 219, 1806, 848] | PASS | PASS | PASS (1.6) |
| V4-070 | map-road-south | [400, 144, 1517, 848] | PASS | PASS | PASS (2.18) |
| V4-081 | arrowheads | [379, 659, 1535, 848] | PASS | PASS | PASS (2.39) |
| V4-084 | map-artemisium | [384, 141, 1535, 848] | PASS | PASS | PASS (1.93) |
| V4-090 | map-plataea | [388, 227, 1530, 848] | PASS | PASS | PASS (4.13) |
| V4-094 | epitaph | [462, 347, 1453, 609] | PASS | PASS | PASS (1.58) |
| V4-099 | end-card | [189, 386, 1730, 935] | PASS | PASS | PASS (9.26) |

NO TEXT OUTSIDE SAFE AREA, NO IMAGE OUTSIDE FRAME, NO OVERLAP WITH SUBTITLES, NO CLIPPED QUOTE
(epitaph Greek + English + attribution all inside the card), NO CLIPPED CREDITS (end card). The
Plutarch beat (stock + subtitle) is unchanged. Contact sheets: `qa-graphics-safe-area-1..3.jpg`.

## QA (24 technical checks, all PASS)

Technical: 1920×1080, 30 fps, 751.2 s, H.264, no accidental black, no frozen picture, no silent
gaps, exact frame count (the segment concat drops 12 frames at joins; the final encode re-sequences
by index and cuts to the timeline's 22,536 frames). Audio: −14.0 LUFS, TP −1.8 dBFS, patches
loudness-matched (gains +0.0 to +2.2 dB), 30 ms joins, no digital silence (room tone from the
scene). Visual: 17 graphics geometry, safe areas, end cards, CTA layout, credits. Subtitles:
rebuilt from the final narration stems, all 1,650 script words covered, highlighting in sync.
Motion share 72.6%, 158 SFX cues, 17 animated graphics.

Timeline deviations from the frozen durations (narration-led cuts): V4-012 8.67 s vs 4 s (the
title holds while the patched P01 sentence ends earlier; its stock plays at 1.5× and the last
0.39 s is the clip's own reversed tail, no frozen frame), V4-029, V4-051, V4-068, V4-080 as in V2,
V4-CTA2 9.63 s vs 7 s.

## Cost

| Item | USD |
|---|---|
| Before V3 (V2 ledger 16.8295 + gate 0.0776 settled conservatively) | 16.9071 |
| V3 TTS: 10 calls, 1,005 characters (8 segments + 2 CTA), 0 retries | 0.2010 |
| V3 render, graphics, QA, proxy (FFmpeg/sharp on the runner) | 0.0000 |
| **Cumulative (ledger committed, conservative)** | **17.1081** |
| Hard cap / remaining margin | 19.00 / 1.8919 |

ElevenLabs counter lag: the provider counter had not reflected the gate at render time; both the
gate and the V3 calls are booked at projected cost (counter lag ≠ zero spend). No Runway, no
OpenAI, no other provider.

## Delivery (Review Delivery route, no signed URL, no HLS, bucket private)

480p review proxy `VIDEO-004-Three-Days-at-the-Hot-Gates-v3-review-480p.mp4` (51,234,723 bytes,
751.21 s, 854×480, H.264 yuv420p, AAC, faststart, sha256 `86ab8583…ff72`), verified through the
same authenticated object path the route uses (200, video/mp4, Range 206). Link:
`https://atomivid.vercel.app/r/video-004-v3-review` (owner login).
