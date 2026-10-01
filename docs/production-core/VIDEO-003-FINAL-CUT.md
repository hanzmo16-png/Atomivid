# VIDEO #003 — "The Lake That Held Its Breath" — Final Cut candidate (for owner review, not published)

Project `video-003-lake-nyos`, authorized freeze `ed78405b8726e16aa7e890247085b6a045706f5b333ba06b0d4c1443b9aaed57`,
frozen PI V1.1 engine tree `fb24a4026e29815b9c8a2071e2db474d3d399adb50c933e276f1480f05a2cbef` (unchanged).

## Master
- `VIDEO-003-The-Lake-That-Held-Its-Breath-master.mp4`: 463.233 s (7:43.2), 1920x1080, 30 fps, H.264 + AAC stereo,
  300,061,280 bytes, sha256 `49c1be40f3133b109890c950274fc9ced5af79fa3ab1b1e61d5cbcda31a36f8d`.
- Produced by workflow run 36808740363 (commit c83aa34): direct MP4 artifact (30 days) and review artifact
  `video-003-run-36808740363` (QA sheets, qc.json, timeline.json, production-manifest.json, SRT/ASS subtitles).
- Durable copy: Storage `videos/video-003-lake-nyos/final/` (7 parts + manifest.json + production-manifest.json).
  Phone playback: signed HLS `videos/video-003-lake-nyos/watch/hls/index.m3u8`, verified anonymously in the same run
  (playlist 200, 16/16 segments, 462.8 s). Signed URLs are kept out of git.

## Timeline
93 slots (narration-led: each shot lasts its narrated words plus a declared pause). Narrated 433.9 s, total 463.2 s.
Hook: 9 cuts in the first 30 s. 10 Runway clips (59.8 s, 12.9% of the runtime), 53 still/graphic slots with camera
motion, 30 stock slots. One duration deviation from the frozen plan: V3-090 (3.9 s vs 6.5 s; the narrator spoke the
line faster). Fallbacks after three failed stock searches: V3-003 reuses the approved misty-cattle clip (V3-006) at a
later in-point; V3-004, V3-038, V3-039 and V3-084 use generated stills (two stock candidates carried a trademark).

## QA
Technical 17/17: duration, 1080p/30, H.264, stereo, no black, no freeze, no silent gap, -14.0 LUFS, true peak -2.9 dBTP,
all slots sourced by checksum, no placeholders, subtitles cover all 1,000 narrated tokens, hook pacing, no held frames,
frozen generative set honoured. Editorial: 47 stills, 10 clips and 34 stock sources reviewed (see
`content/productions/video-003-lake-nyos/reviews.json`); no victims depicted; reconstruction notice in the hook;
the landslide hypothesis is captioned as one of several hypotheses.

## Cost (COGS only; provider top-ups are not COGS)
USD 7.8761 of the USD 29.44 authorized reservation (hard cap 32): ElevenLabs 1.1262 (5,631 characters),
OpenAI 2.9999 (47 stills), Runway 3.75 (10 clips), Pexels 0. Expected was 7.08; variance +0.80 (four fallback stills,
+0.28; stills averaged 0.064 instead of 0.08 for the rest). 58 paid operations, 0 retries, 0 released claims.
Ledger: `videos/video-003-lake-nyos/ledger.json`. Remaining ElevenLabs quota: 24,253 characters (resets 2026-10-16).
