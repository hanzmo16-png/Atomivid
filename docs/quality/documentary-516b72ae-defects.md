# Documentary 516b72ae — defects found in review (2026-10-09)

Scope: Hans's finished test documentary (long-form, 16:9). Documentaries stay in early access; this record
does **not** authorise regenerating the video or changing the long-form compositor. It fixes what "corrected"
must mean when that work is scheduled.

Evidence: review run `37946666634` (workflow `review-video.yml`, branch `claude/video-review`). Frames,
contact sheets and the script/plan are sealed in branch `ops-sealed-out`, folder `review-37946666634/`
(private: decrypt with the session key). Nothing private is reproduced here.

## Technical measurements (valid)

| Check | Result |
|---|---|
| Streams | H.264 1920×1080 30 fps, AAC 48 kHz stereo |
| Duration | 171.1 s for 180 s requested (−5 %) |
| Loudness | −16.0 LUFS integrated, −2.2 dBFS true peak, LRA 2.2 LU |
| Silences > 1.2 s | none |
| Black stretches / frozen > 4 s | none |
| Cuts | 37 (13 per minute), longest shot 11.7 s |

## Defects (editorial / visual)

### D1 — "Material pendiente" placeholder delivered to the viewer — blocking
- Where: 0:07, 0:49, 1:27 and 1:32 — dark slate with the narration line in large type and a red
  "Material pendiente" badge top-left (rendered by `SceneLabels` in `remotion/LongFormDoc.tsx` when
  `scene.pending` is true).
- Why it matters: an internal production marker is visible in a deliverable; the slate also duplicates the
  subtitle text.
- Correction criteria: a completed delivery contains **zero** frames with the badge or pending slates. Either
  the shot is resolved with a real asset before the final render, or the job does not reach `completed`
  (release gate fails with a clear reason). Verify by frame sampling every 2 s plus a check that no scene in
  the final manifest has `pending: true`.

### D2 — Footage unrelated to the narration — major
- Where (examples): 0:40–0:45 river rapids; 0:59 person pointing at a wall map; 1:13 phone in hands;
  1:18 child at a chalkboard; 1:42 "Details" mind-map print; 2:01 project-management / marketing-funnel
  papers; 2:20 illuminated Arabic manuscript. The topic is the solar wind and auroras.
- Why it matters: generic stock weakens credibility; some images suggest unrelated subjects.
- Correction criteria: every shot's subject matches its narration beat (astronomy, Sun, magnetosphere,
  atmosphere, auroras, or a stated historical/scientific context). Off-topic office, classroom, device or
  religious imagery is rejected at selection unless the beat explicitly names it. Reviewed shot by shot
  against the plan; target 0 unrelated shots.

### D3 — Faint subtitles on some shots — minor, needs confirmation
- Where: 0:26, 1:23, 2:10 — subtitle text looks low-contrast in the sampled frame.
- Caveat: these samples may fall inside a crossfade; confirm on the full-rate video before fixing.
- Correction criteria: subtitles keep their backing box and full opacity for the whole cue, including during
  shot transitions; contrast ratio ≥ 4.5:1 against the box on every sampled frame.

## Not assessable from this review
- Narration quality (voice, pronunciation, pacing as heard) and music choice/mix: requires listening.
- Factual accuracy of each claim beyond the script's own source tags.
