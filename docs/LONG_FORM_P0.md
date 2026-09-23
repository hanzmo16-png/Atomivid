# Long Form P0 — technical chain (fixtures)

Isolated orchestrator. Does not modify Shorts or Avatar.

## What this drop proves

A 24 second fixture master:

- 1920×1080
- ~30 fps
- 16:9
- 6 shots × 4 s, **six distinct shot types**
- 3 segments concatenated
- fixture voice tone + music bed
- burned-in captions (libass `subtitles` filter; `drawtext` is not required)
- ffprobe when it exists, otherwise `ffmpeg -i` parsed the same fields
- `paidApisCalled: false`

This is **not** an 8–12 minute documentary.

## Reproduce

```
LONG_FORM_P0_CLI=1 node scripts/render-long-form-p0.mjs ./p0-output
```

No paid APIs. Requires local `ffmpeg`. `ffprobe` is used when it is on `PATH`.

`LONG_FORM_P0_CLI=1` does **not** set `LONG_FORM_ENABLED` and does not allowlist any user.

## Remotion

Assembly stays ffmpeg concat. A later Remotion 16:9 composition can replace per-shot encoding without changing the segment contract. Shorts `remotion/Root.tsx` is not touched.

## Model

`VIDEO → SEGMENTS → NARRATIVE BEATS → shots[]`

A beat always expands to at least two shots of 3–8 s. The earlier contract's single `visualIntent` per beat is not the render model.
