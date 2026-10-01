# VIDEO-004 Thermopylae — V2 CINEMATIC (scenario B) · Final Cut candidate

Status: **THERMOPYLAE_V2_READY_FOR_HUMAN_REVIEW**. Not published. V1 master, frozen package 916059ce, frozen storyboard and the
historic ledger entries are untouched; V2 is a separate master under `final-v2/` built from the delta in `v2/storyboard-delta.json`.
Final render run 36876459184 (request v2-04).

## Master V2
- `VIDEO-004-Three-Days-at-the-Hot-Gates-v2-master.mp4` · 526.8 MB · sha256 `eca494aa3881204724c7a9211f7eebc08893ffb3caa3ed587fe626ba4e236b10`
- 1920x1080 · 30 fps · H.264 · 736.8 s · -14 LUFS · true peak -3.3 dBTP · LRA 3.4 LU (no clipping after the sound-design stem)
- Technical QA 17/17 PASS. Review proxy 854x480 (51.1 MB) verified anonymously: GET 200, Range 206, video/mp4.

## V2 special QA
| Metric | V1 | V2 |
| --- | --- | --- |
| Significant motion (AI clip, stock, animated graphic) | 280 s (38%) | 531.1 s (72.1%) |
| Motion in 0:00–1:00 | 36 s | 47 s |
| Longest single still | 16.7 s (V4-042) | 14.5 s (V4-047) |
| Longest still chain | 33.8 s | 33.8 s (V4-055+056+057) |
| Still chains ≥ 2 | 13 | 6: V4-014+V4-015 (11.9 s); V4-020+V4-021 (13.9 s); V4-036+V4-037 (12.6 s); V4-051+V4-052 (14.1 s); V4-055+V4-056+V4-057 (33.8 s); V4-074+V4-075 (8.9 s) |
| AI clips in master | 13 | 24 (166 s) |
| Animated graphics | 0 | 17 (16 graphics + Persian-kit callouts) |
| Procedural SFX cues | 0 | 158 |

## The 13 scenario-B clips
PASS (11): V4-006 Greeks waiting, V4-028 Leonidas at the gate, V4-031 column north, V4-039 Spartan on the shore, V4-043 Immortals, V4-048 Medes, V4-050 spear hedge, V4-067 allies leave, V4-071 host forms, V4-077 Persians from the forest, V4-089 Salamis.
FAIL → documented still fallback, no retry spend (2): V4-055 the shade (second attempt; the arrow flight again degrades into noise), V4-079 arrows on the mound (dust erupts like an explosion).

## Sound design
Procedural only (FFmpeg noise/sine synthesis): no external recording, no licence, no attribution needed. Intentional silences: *the pass held*, the empty platform, the council, the Thespians (music out 3 s), *into the open* (music out, footsteps and breathing, impact on contact), the fallen helmet (1.6 s total silence), the epitaph.

## Cost
| | USD |
| --- | --- |
| Historic V1 | 11.3295 |
| Incremental V2 (Runway: 9 × 10 s, 4 × 5 s) | 5.50 |
| **Cumulative total** | **16.8295** |
| Expected total | 17.65 (variance -0.82: no retry spend) |
| Hard cap | 19.00 (margin 2.17) |
| By provider | ElevenLabs 1.7766 · OpenAI 3.8029 · Runway 11.25 |

## Known defects for human review
- Two arrow shots stay stills (V4-055, V4-079): the generator fails on dense arrow flights twice; a different composition would be needed, not a retry.
- The longest still chain is the shade/relays/Ephialtes run (33.8 s) for that reason.
- Animated-graphic cue timing depends on word matching; check the hoplite-kit highlights land on each item.
- Several slots slow their clips up to 1.5x; judge at full speed.
