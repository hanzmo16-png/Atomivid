# Long Form web readiness

## Scope

The website already has a documentary form, script review, production plan,
confirmation, background worker and result delivery. A separately produced sample
does not verify this complete website flow. These changes address the first
concrete differences between the two paths; they do not enable a public rollout.

## Changes

- The documentary form accepts Spanish or English. The server validates the
  value before generation, sends it to the script generator, saves it with the
  request and preserves it after an error. Older clients default to Spanish.
- The render worker selects Brian for English Long Form. Spanish, Reel and
  Avatar keep their existing voice settings. The model still uses the configured
  `ELEVENLABS_MODEL_ID`.
- Scene provenance and pending-material labels follow the documentary language.
- Long Form measures the downloaded music bytes with ffprobe. The curated
  provider's duration metadata may describe the requested video length, so it
  cannot establish the source loop period.
- Music repeats as consecutive non-looping sequences while retaining the global
  fade and narration-gap volume envelope. Explicit sound cues can declare their
  actual source duration and use the same expansion.

## Verification

Automated checks cover the real server action with isolated auth, generator and
database dependencies; invalid and unauthorized requests cannot reach generation.
The pipeline test supplies a short music file with deliberately incorrect duration
metadata and checks that the renderer receives its measured source length and
English language. Direction tests check repeated segments, offsets and fades.

Run `npm run typecheck` after `npx next typegen`, and `npm run test:unit`.
The ffprobe package needs its normal postinstall step; using `npm ci
--ignore-scripts` requires `npm rebuild @ffprobe-installer/linux-x64` before media
tests. One existing randomized loudness test failed on an initial run, then passed
on the repeat; its noise input is not seeded.

`node --import tsx scripts/verify-long-form-web-audio.ts` is a separate free
six-second render check with local HTTP-served synthetic audio. It measures the
music after multiple source periods and deletes its temporary MP4. It has **not
passed in the current workspace**: Remotion startup failed at
`os.networkInterfaces()` with `uv_interface_addresses` before rendering. Run it
on a supported render host before treating the audio change as media-verified.

No paid generation was invoked for this change. No production deployment or
feature flag change is included in this verification.

## Remaining release checks, in order

1. Run the synthetic real-render check and inspect the language selector in a
   preview deployment.
2. Review the current quality policy: shorter text-only cards, more moving
   wildlife/other relevant footage, captions synchronized to spoken words, and
   scene-specific music. These requests are not completed by this patch.
3. Verify the intended voice model, generated script length, resource licensing,
   cost estimate and budget guard in the website's plan. The form currently
   requires sources; topic-only research is not implemented. Generating a script
   itself invokes a paid provider.
4. With an agreed production budget, execute one complete flow from the website:
   topic and language → script → plan and cost → confirmation → progress →
   playable, downloadable video. Review the actual result before a larger batch.

Real coastlines from the separate documentary branch and automatic private media
archiving after render are not integrated by this change.
