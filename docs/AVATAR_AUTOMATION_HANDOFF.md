# Avatar production — operating agreement (2026-09-18)

The owner authorizes autonomous technical decisions, execution, and use of
existing provider credits when needed. New monetary charges require explicit
approval: credit purchases, top-ups, paid overages, subscriptions or renewals.
Confirm a generation is covered by existing credits before submitting it;
unknown metered charges are not authorized. This supersedes the earlier
requirement to ask before every credit-consuming generation.

## Verified

- Rotated D-ID credential authenticated with HTTP 200 in Actions run
  35379635669, commit 351f88de3df96f099c45840e70c303578ca7bb40.
- The D-ID adapter accepts an audio URL. The current avatar worker generates
  that audio through TTS; user-recording upload is NOT connected end to end.
- A demo was generated manually in Studio and supplied by the owner.
- Its display aspect is 9:16 despite encoded dimensions 1920x1920: SAR is
  9:16. It is 42.8 seconds, 25 fps, H.264 with AAC. Do not label it square
  based on encoded dimensions alone.
- The avatar picture occupies only part of the white canvas. Existing
  trial watermarks remain visible. Reframing needs no paid regeneration.

## Local execution

Use `scripts/prepare-avatar-demo.py SOURCE OUTPUT --crop X Y WIDTH HEIGHT`.
Coordinates refer to the normalized 1080x1920 display image. Inspect a frame
before selecting a crop. This script never contacts an external service.
It preserves audio packets and verifies dimensions, aspect ratio, duration,
and full decode, then writes an adjacent QA report. Neither technical QA nor
sampled frames establish perceptual lip-sync quality or exact transcription.
Do not commit personal assets, reports containing private locations, or videos.

## Remaining remote integration

1. Add authenticated private recording upload with ownership, size, format,
   and measured duration validation. Keep credentials on the server.
2. Persist the selected recording with the request. Explicitly skip TTS when
   using a recording and never fall back to a synthetic voice on failure.
3. Produce a no-generation preflight: selected image/audio, duration, display
   ratio, available credits, and proposed consumption. Review the preview
   before generation. Existing credits are authorized; request approval only
   when new monetary spending is required.
4. Record exact asset hashes and expected credit consumption. If new money
   is needed, obtain approval for that amount first. Use the existing
   persistent one-attempt lock; never spend credits on accidental duplicates.
5. Save the provider job immediately. Retry retrieval only, never regenerate
   automatically when completion is uncertain.
6. Download and perform local QC, reframing, editing and export. Report any
   checks that require actual listening/playback separately.

This integration remains pending; do not describe it as deployed or working.
Existing-credit generations are authorized. Additional charges and
subscriptions still require approval. Necessary login/MFA may require the owner.
