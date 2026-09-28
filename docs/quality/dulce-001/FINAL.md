# DULCE: What Came Home — final master v2 (for owner review, not published)

- File: `DULCE-What-Came-Home-final.mp4`, 310,553,092 bytes, sha256 `ecfb84452883123c71b7cf717ac5c3df5309798651749b3efcb223463f485eeb`
- 9:30.0 (570 s), 1920x1080, 30 fps, H.264 ~4.4 Mbps, AAC 192 kbps stereo 48 kHz. Upscaled from Runway's native 1280x720 (not native 1080p).
- Produced by run 53 (`render` stage, commit 6273d7c): https://github.com/hanzmo16-png/Atomivid/actions/runs/36417331448
- Durable copy: Storage `videos/dulce-001/full-v1/final/` (7 parts + `manifest.json` with sha256; overwrote the v1 parts). Reassemble: `cat *.part?? > DULCE-What-Came-Home-final.mp4`.
- Previous master (v1, sha256 `69cbe102…`) remains downloadable from run 51 until 2026-10-28: https://github.com/hanzmo16-png/Atomivid/actions/runs/36382719834

## Corrections in v2
- D10-04 (7:29–7:36) and D11-03 (8:08–8:17): the v1 animations let Runway bring a stranger into the wife's close-up (man in white cap and blue shirt; blond boy in blue). Both were re-animated from the same approved wife-only stills (revision v2, run 52, USD 1.00). Runway again pushed a figure in from the right edge after ~2 s, so the render reframes those two clips to a 960x540 window on the wife (`renderCrop`), verified clean at 4 fps over the whole edit window. The two shots are slightly softer than their neighbours (2x upscale of the crop).
- Subtitles: the reported "fictional,retelling" and "Thomas s house" were artefacts of the downscaled contact sheet, not errors. Source text and burned-in subtitles read "fictional retelling" and "Thomas's house" at full resolution. The .srt/.ass are byte-identical to v1.
- Everything else is unchanged: 71 other shots have identical checksums and timing; narration, music plan and mix settings are the same.

## Automatic QC (all 15 passed)
Duration matches plan; 1080p/30; stereo audio throughout; no black segments; no frozen picture ≥2 s; no audio silence ≥1.2 s; -14.1 LUFS integrated, -1.2 dBTP; every shot sourced by checksum; no frozen fill; 1,542/1,542 words subtitled; max hold 9.17 s; hook fully animated.

## Visual QC
Hook 0–30 s at 1 fps, 7:25–7:45 and 8:05–8:35 at 2 fps, and the two subtitle lines at full resolution were reviewed on the delivered file.

## Spend
Episode ledger: USD 55.64 (ceiling raised from USD 55 to USD 56.65 for the owner-authorized corrections). This correction: USD 1.00 (two Runway clips); the render makes no paid calls.
