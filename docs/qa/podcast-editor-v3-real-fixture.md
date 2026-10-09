# Editor v3 integration: actual generated delivery

The user-supplied `podcast-editor-entrega-v3.zip` was recovered and inspected.
The runtime source is now in `scripts/podcast-editor-v3/`, unchanged from that
archive. `podcast-editor-v3-fixture.json` records source SHA-256 checksums.
No SQL from the archive was applied. No provider API was called.

## Failure found and fixed

On PR #86 commit `8ef0de5`, the actual editor-generated fixture gave 10 passing
tests and 1 failure: `COMPLETO.json sin verificacion`. The publisher writes
`verificacion: "completa"` (or `"sidecar"`), not an object. The consumer now
accepts exactly those enum values and still independently hashes every declared
object before returning `terminado`. Unknown values and object/array values fail.

The real publisher lists MP3 before MP4. Primary playback now prefers a video
when one exists, with audio as fallback. The integration test checks this.

## Evidence

- Real Python editor 0.3.0 ran validate, render and publish with its local backend.
- Synthetic FFmpeg test patterns and tones only: 9.52-second MP4, MP3, contact
  sheet, 12 frames, credits and render report; 17 declared output objects.
- `src/lib/podcast/editor/fixtures/editor-v3/episodios/prueba-v3/v1/` is the
  untouched published folder, including `salida/COMPLETO.json` and sidecars.
- The marker location is confirmed by `podcast_editor/storage.py`, not assumed.
- Consumer tests: **11 pass, 0 fail, 0 skipped** after the fix. The integration
  fixture is now required; its disappearance fails CI rather than skipping it.
- Actual editor output bytes and hashes are tested; the storage adapter and
  upload timestamps in the consumer test are simulated. This does not prove
  live Supabase Auth, Storage, TUS, browser playback or authorization.

## Reproduce

Requires Python 3.10+, FFmpeg/ffprobe, libx264/libmp3lame/AAC, DejaVu fonts.
The fixture here was generated with FFmpeg 6.1.1; the upstream package recommends 7.1.

```sh
python3 scripts/podcast-editor-v3/generate_fixture.py /tmp/editor-v3-fresh
node --import tsx --test src/lib/podcast/editor/editor.test.ts
```

The generator uses a new destination and never replaces an existing delivery.
New render reports contain runtime paths, timings and timestamps, so a new
marker/report hash is expected; the contract and media checks must still pass.

## Production still pending

The confirmed owner matches both the existing Travis Walton episode owner and
the production asset-curator allowlist. No account identifier or email is
published here. Vercel marks `INTERNAL_PRODUCTION_OWNER_USER_ID` sensitive and
does not disclose its value through the connector; exact equality with that
variable is not claimed. There is no need to copy it to GitHub for fixture tests.

After explicit user authorization on 2026-10-09 at 15:22 America/Cancun,
the confirmed account was enrolled in `podcast_editor.propietarios`.
This grants the approved owner read access and assignment management; no editor
assignment, SQL policy change, media regeneration or global limit change was made.
Live delivery and owner-session playback/download remain pending. Keep PR #86
draft and unmerged until those gates are completed.
