# ATOMIVID PRECAMPAIGN V2 — VFX-002 SUBJECT-LOCKED COMPOSITING — QA

**Status: VFX-002 PASSES the quality gate and is integrated into the master. Ready for human review. NOT published.**

## Method (local, USD 0.00, 0 provider calls)

The pipeline is **HANS ORIGINAL PIXELS + SUBJECT MATTE + NYC PLATE + LOCAL COMPOSITE/RELIGHT**. Code: `scripts/precampaign-teaser/vfx002.py`, `vfx002_matte.py`, CI stage `v2-vfx002` (`v2-vfx002.ts`).

| Phase | Method |
|---|---|
| A. Matte | Robust Video Matting mobilenetv3, run locally as ONNX on CPU (sha256 `88d45312…`). It is recurrent, so the matte stays temporally coherent. No chroma key. Refinement: 3% choke, 0.8 px soften, and temporal smoothing applied only to edge pixels whose source did not move. |
| Edge refinement | The edge band is un-premultiplied against a clean plate of the apartment. That plate is the temporal median of uncovered pixels, which works because the camera is fixed. This removes the white spill from the ceiling. |
| B. Plate | Raw material is the VFX-001 Luma output, already paid for and replayed from the ledger with its sha256 verified. No new call was made. The generated person was matted out with RVM. The plate is the temporal median of uncovered pixels; the residual hole is inpainted, darkened and blurred. It is upscaled 720→1080 with lanczos, then given a night grade (teal shadows, warm sodium highlights), depth-of-field blur and bloom. |
| Ambient motion | All local: fog drift, light flicker of ±1–2%, and grain matched to the plate. |
| C. Transformation | Spatial reveal outward from behind Hans, ordered by distance and room luminance, 0.40–1.90 s into the clip. The room dims ahead of the front, a narrow warm light sweep (screen blend) follows, and there is subtle displacement at the front. No cut, no "PowerPoint" wipe. |
| D. Composite | Out = Fg·α + BG·(1−α). Hans gets only a per-pixel grade/relight that ramps in: exposure −7%, warmer, +6% contrast, and a vertical key falloff down the body. There is a very subtle light wrap on the rim, and the gaps between arms and torso fall into shadow. No drop shadow on the distant street. No camera motion and no parallax, because the camera is fixed. |

## Subject lock (SUBJECT_PIXELS_LOCKED = TRUE)

| Check | Result |
|---|---|
| Interior of the matte (α ≥ 254, eroded 12 px), 161,647,271 px over 150 frames: max \|composite − graded source\| | **2/255** (light-wrap tail and rounding) |
| Same interior vs the ungraded source | max 50/255. This is the allowed grade/relight only; there is no regeneration. |
| Visual proof | `media/vfx-002/vfx-002-source-vs-composite.mp4` shows SOURCE \| VFX-002 \| SUBJECT DIFF ×20. The subject panel is black (identical) except a 1–2 px rim. See also `lock-proof-frames.jpg`. |

The face, tattoos, glasses, watch, bracelet, T-shirt, hands, mic and hair all come from the real take.

## Matte quality

| Metric | Value |
|---|---|
| Alpha flicker on static edge pixels (mean \|Δα\| where the source did not change) | **0.033** (raw RVM 0.046, so −29%) |
| Mean frame-to-frame alpha change (whole frame) | 0.0035 |
| Plate hole visible behind the subject | 0.41% of pixels per frame, all in the arm/torso gaps and shadowed |

Visual review covered hair, beard, shoulder edges and fast hand motion (frame 104). Results: no halos, no cut hair, no missing hands or arms, and no background showing through the body.

## Quality gate

| Criterion | Result |
|---|---|
| Evident halo | No |
| Artificially cut hair | No |
| Hands or arms disappearing | No |
| Matte flicker | No (low metric; checked on consecutive frames) |
| Background passing through the body | No |
| Absurd perspective | No. The plate comes from the same camera geometry (depth-conditioned on this take); the camera is fixed. |
| Incompatible lighting | Acceptable. The relight lowers and warms Hans' key toward the sodium street light. |
| Looks like a pasted background | No. DOF, bloom, grain, light wrap and color match are applied. |
| Amateur | No |

## Residual defects (honest)

1. **Static plate.** The plate is a single still image with only subtle local motion (fog, flicker, grain). It has no traffic and no moving lights. A truly dynamic premium plate would need a paid generation. See the provider #2 recommendation below.
2. **Generated plate material.** The plate comes from a 720p AI generation. It is soft once upscaled, which the DOF blur masks. The brownstones are AI-generated, not a real location.
3. **Silhouette fill in the plate.** `vfx-002-background-plate.png` is not a clean plate on its own. The removed person leaves a blurred silhouette fill, which in the composite is fully behind Hans except the shadowed body gaps.
4. **Transition dark ring.** During the reveal (about 1.0–1.6 s of the clip) a soft dark "lights going down" ring passes around the head. This is deliberate, but some viewers may read it as a vignette.
5. **Lighting.** Hans remains brighter than a real night street would light him. It reads as a key light on an interview subject, not as ambient street light.
6. **Mic.** The BOYA mic remains visible because it is the original pixels.

## Master V2 + VFX-002

- **Duration and format:** 34.43 s, 1080×1920, 30 fps.
- **Audio:** −14.3 LUFS, TP −1.5.
- **A/V sync:** max drift 38 ms.
- **QA:** all 14 automatic checks pass.
- **VFX window:** opening trimmed 2.5–9.7 s; VFX window 4.7–9.7 s, layered with no fade. The composite starts on the untouched source, and there is no frame-difference spike at the insert point.
- **Reused assets:** the new real audio, the warm/tan polish, the existing avatar and persisted TTS (ledger replay, 0 calls), DULCE, Ocean, music, the premium dissolve, captions and CTA.
- **Storage:** master at `videos/precampaign-teaser-v1/output/ATOMIVID-precampaign-v2-cinematic-vfx002.mp4`; composite at `videos/precampaign-teaser-v1/v2/vfx-002-composite.mp4` (sha256 `cba889ba…`).
- **NO-VFX master:** stays at its own path, unchanged.

## Cost

| Item | USD |
|---|---|
| VFX-002 (matting, plate, composite, master) | **0.00** (0 provider calls) |
| V2 total (VFX-001 attempt #3, already spent) | 1.08 |
| V1 (TTS + avatar, reused) | 0.1784 |

## VFX provider #2 (research only; nothing was spent or integrated)

**Recommended: Runway API.**

| Use | Model and endpoint | Cost |
|---|---|---|
| Edits | `aleph2`, `POST /v1/video_to_video` | ~USD 0.28/s, so ~USD 1.40 for 5 s |
| Background-only plate | Gen-4.5 (text/image→video, `720:1280`) | ~USD 0.60 for 5 s |
| Background-only plate | Veo 3.1 (`1080:1920`) | ~USD 1.20 for 6 s, no audio |

- **SDK and API:** `@runwayml/sdk` 4.21.0, where `aleph2` replaces `gen4_aleph`. Output follows the input aspect.
- **No identity lock:** Aleph has no face or identity lock, so it would be used **only for background plates**, composited behind the locked subject as here.
- **Unverified figures:** credit prices and Aleph limits come from search snippets of the docs; the docs site was not reachable from the sandbox. Verify them before any spend plan.
- **Why not the others:** Kling and Pika have weaker official v2v edit APIs. Veo, Seedance and Wan are already reachable through the same Runway API.
