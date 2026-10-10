# Travis Walton — final edit v4

The final edit adds four approved Hans avatar interventions to the v3 montage.
All 31 original media assets, the narration/music mix, subtitle timing, and chapters are retained.
The timeline remains 813.92 seconds at 1920 × 1080, 25 fps.

| Intervention | Timeline start | Timeline end |
| --- | ---: | ---: |
| Presentation | 66.60 s | 87.00 s |
| Question | 174.28 s | 196.68 s |
| Turn in the story | 563.56 s | 587.64 s |
| Closing address | 789.64 s | 813.92 s |

The last avatar frame is held through the final 0.04 seconds; the six-frame stock insert immediately before the closing address is absorbed into the preceding still image. Avatar-generated audio is discarded, preserving the existing final mix. The avatar uses the approved studio background and carries an on-screen AI avatar label.

## Generation and publication

- Avatar generation: workflow `38018270837`, successful attempt 2. One accepted provider job, 91.12 seconds, 1080p, full decode without errors. Recorded wallet cost: USD 3.51. Reuse the private `avatar-final/result.json` receipt; do not resubmit the paid generation.
- Final edit workflow: `38019159589`, code `e2cf225dbc6e2394caa62067bc4a64fc89f7ce04`.
- Publication uses a temporary authenticated owner session and a v4-only assignment. The editor account remains exclusive to Grok.
- Every input is read back and checked before `entrada/LISTO.json`; every output is read back and checked before `salida/COMPLETO.json`. No previous version is overwritten.
- The editor validates complete media decoding and trims subtitle cue tails to the timeline end, matching the v3 fixes reported by Grok.

## Validation status

Final edit workflow `38019159589` succeeded. The editor finished in 373.44 seconds and all 16 media checks passed: complete MP4/MP3 decoding, 1080p/25 fps, exact timeline length, preserved mix levels and ending, and 358 subtitle cues without overlaps or out-of-range times. Four avatar frames and the final contact sheet were inspected visually.

- MP4: 306,471,146 bytes; SHA-256 `9acc8ae5bb4b0ced10a76015df5da8b9126226e3e2a90999417b955b0d1d9312`.
- MP3: 19,536,875 bytes; SHA-256 `f1775a9f0f3ec4b5ac866fa7d5e58acaf8ad9f26c8b1a9181c2f1cad88dbbf0b`.
- Input manifest SHA-256: `b923fabf65113dc9cca8edfeab1a968cb059afd84ba5b420c907cc62eba24e9a`.
- `COMPLETO.json` exists after all output checks. The publishing session was closed and its temporary v4 assignment was revoked.
- Production browser workflow `38020062730` passed all 11 checks, pinned to v4: delivery listing, verification to `terminado`, video playback, all 19 downloads with exact bytes and SHA-256, 15-minute signed-link lifetime, non-owner 404, and anonymous login redirect/API 401. Both temporary sessions were closed and the throwaway QA account was deleted. The workflow completed successfully.

Final delivery: https://atomivid.vercel.app/dashboard/podcast/editor/922615a5-9673-42c0-8b6e-5f3a60193b18/v4

## Supply-accounting correction

Two migrations preserve the existing daily budget and call cap while correcting a proven cancellation before provider submission. They permit only the reconciliation flag transition on an otherwise immutable, zero-charge refunded record and exclude only that reconciled, unsubmitted cancellation from the provider call count. Actual provider requests and uncertain cancellations still count. See the migrations dated `20261010024028` and `20261010025048` and the cancellation reconciliation SQL test.
