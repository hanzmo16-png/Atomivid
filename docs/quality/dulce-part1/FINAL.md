# DULCE — PART I: final master (for owner review, not published)

Not DULCE V1. New English script (14 beats, 1,228 words, 7,369 characters), narrator David (`cCYjmrGZaI86GUJ7F2Nn`, eleven_multilingual_v2, alias dictionary Dulce/Castello/Bennewitz), Smart Mix B+, ending on Nightmare Hall + Paul Bennewitz + disinformation and the end card "DULCE — PART II: NIGHTMARE HALL".

- File `DULCE-Part-I-master.mp4`: 9:42.7 (582.7 s), 1920x1080, 30 fps, H.264 + AAC stereo, 278,960,791 bytes, sha256 `28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f`.
- Produced by run 21 (commit 5483fa6): https://github.com/hanzmo16-png/Atomivid/actions/runs/36486484586 (direct MP4 artifact, 30 days).
- Durable copy: Storage `videos/dulce-part1/final/` (6 parts + manifest). Phone playback: signed HLS `videos/dulce-part1/watch/hls/index.m3u8`, verified anonymously in run 22 (playlist 200, 20/20 segments, 582.7 s). The signed URL is kept out of git.

## Picture (127 slots)
- 11 new B+ Runway clips (N01, N04, N05, N11, N12, N26, N33, N35, N41, N46, N48), 70.9 s; 12.2% of the timeline is new generative video, 52.0% of generative origin including reused V1 footage.
- 52 still + controlled camera-motion slots, 58 V1 re-cuts, 3 graphics, 2 black (the 2.2 s "Can we prove this man ever existed?" beat and the end card).
- Fallbacks: N20 (Runway returned no video twice) and N43 (identity drift) use the approved still with camera motion; N11 uses only its clean first 3.4 s.

## Fixes made while reviewing the master
1. The six B+ upgrade clips had been approved but never switched in the storyboard; the first renders used their stills. Each clip now fills its planned slot.
2. Name captions and the graphic's "not verified" notice overlapped the subtitles; they moved to the top.
3. Three slots held their last frame (up to 0.68 s); they now slow down (≤1.5x).

## QA
Technical (15/15): duration, 1080p/30, stereo, no black, no freeze, no silence, -14 LUFS / -3.1 dBTP, every slot sourced by checksum, no placeholders, subtitles cover all words, >=10 changes in the first 30 s, no held frames. Temporal review of every generative clip (8 frames each), the hook second by second, every 5 s of the episode and every still/generative transition: no duplicate people, identity drift, extra limbs, morphing or unwanted text found.

## Cost (Part I COGS only; V1's USD 54.64 is separate)
USD 9.01 of the USD 40 cap: images 3.79, Runway 3.75, David narration 1.47 (booked on the 7,369 characters sent; the balance counter moved 2,986). Provider top-ups are cash, not COGS: ElevenLabs USD 5, OpenAI USD 10. Creator was not bought.
Cost per approved shot USD 0.118; per finished minute USD 0.93; regeneration rate 6.3%; QA failure rate 4.7%.
