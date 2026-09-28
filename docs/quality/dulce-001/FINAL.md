# DULCE: What Came Home — final master (for owner review, not published)

- File: `DULCE-What-Came-Home-final.mp4`, 310,784,883 bytes, sha256 `69cbe10294c9557bc7b592b0a5f90279c171c39de6c2efca89654a1708a067db`
- 9:30.0 (570 s), 1920x1080, 30 fps, H.264 ~4.4 Mbps, AAC 192 kbps stereo 48 kHz. Upscaled from Runway's native 1280x720 (not native 1080p).
- Produced by run 51 (`render` stage, commit 686f723): https://github.com/hanzmo16-png/Atomivid/actions/runs/36382719834
- Durable copy: Storage `videos/dulce-001/full-v1/final/` (7 parts + `manifest.json` with sha256). Reassemble: `cat *.part?? > DULCE-What-Came-Home-final.mp4`.

## Picture
73 shots, all moving video: 72 Runway Gen-4 Turbo clips from the durable ledger plus the verified Runway laboratory clip (D01-04). No held stills. Average shot 7.8 s, longest 9.17 s. D01-01 and D01-03 were planned as library clips (`Dulce-Runway-01-Pasillo.mp4`, `-02-Encuentro.mp4`) that are not in Storage; they were animated from the approved pilot stills d01/d03 (animation-10, USD 1.00).

## Audio and subtitles
Cached Brian narration for all 12 beats (checksums match the measured beats; no TTS regenerated). Three licensed library cues (tension-1, tension-2, reflective-1), silence-trimmed, crossfade-looped and ducked under voice. Mastered to -14.1 LUFS integrated, -1.2 dBTP. Burned-in word-highlight subtitles from the TTS word alignment: 326 cues, 1,542/1,542 words. The `.srt`/`.ass` files are in the run artifact.

## Automatic QC (all passed)
Duration matches plan; 1080p/30; stereo audio throughout; no black segments; no frozen picture ≥2 s; no audio silence ≥1.2 s; loudness and true peak within target; every shot sourced by checksum; no frozen fill; full subtitle coverage; max hold <10 s; hook fully animated. The contact sheets `qc-hook-0-30s.jpg` and `qc-episode-every-10s.jpg` were reviewed visually.

## Spend
Episode ledger: USD 54.64 of the USD 55 ceiling. This execution: USD 1.00 (two Runway clips); the render itself makes no paid calls.
