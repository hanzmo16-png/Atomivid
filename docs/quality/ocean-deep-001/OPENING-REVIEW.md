# Opening review: motion and short text

## Editorial decision

Hans approved the gold word-highlight captions and requested real motion from the
opening, with black text-only cards limited to 1–1.5 seconds. Longer statements
must sit over moving imagery. The previous 6.08-second and 4.47-second text cards
are unsuitable for that direction.

This review covers 29.2 seconds, ending after the word “mapped” (28.769 seconds),
before “Both” begins (29.373 seconds). It preserves the approved Brian narration
and music mix, with only a 0.15-second audio fade at the end of the excerpt.

The review contains no still photographs and no black text cards:

| Visual type | Seconds |
| --- | ---: |
| Actual NOAA video | 15.233 |
| Previously generated, labeled AI video | 8.900 |
| NOAA scientific sonar animation | 5.067 |
| Total | 29.200 |

The opening is the existing accepted ROV animation, including the particles Hans
accepted. The seabed photograph is replaced by real ROV footage; the jellyfish is
real Atolla footage at 880 m, identified on screen. The long text card becomes
moving ROV/coral footage with a short overlay. The mapping passage uses a moving
sonar explanation. Source scenes illustrate the narrative; they are not presented
as footage from a single dive at 3,000 m.

## Provenance and reuse

- Existing approved sample and mixed audio: Actions run `36323674245`, artifact
  `10932927200`, `sample-approval-minute1-portada.mp4`.
- Existing AI clip provenance: prepare run `36323113770`, artifact `10933840433`.
  The original two clip files are reused, without new generation.
- Original word timings: `@@WORDS b1` in job `108620734602`, run `36319594264`.
- NOAA source pages and download URLs are recorded in `opening-review.json`.
  NOAA's FAQ permits reuse of website media unless otherwise marked; each selected
  source credits NOAA Ocean Exploration without a copyright exception. Credits
  appear in the review. Original NOAA/Veo audio is discarded.
- No new TTS, image or AI-video calls. No workflow registration, deployment,
  budget increase, or changes to the shared episode preparation state.

## Reproduce

Place the selected raw clips, approved mixed MP4 and `words-b1.json` in a private
asset directory. Download URLs for NOAA material are in the JSON. Download the
existing private clips through the owner's storage access; never commit signed
URLs or credentials. Export `words-b1.json` as an array of objects with `text`,
`startSeconds`, and `endSeconds` from the existing narration log.

```sh
node --import tsx scripts/ocean-opening-captions.ts /path/to/assets
python scripts/render-ocean-opening-review.py /path/to/assets /path/to/opening.mp4
```

The caption exporter directly reuses `buildCaptions`, `captionsWithinScenes` and
`withCaptionWords` from the approved caption branch. The local review uses ASS to
draw stable phrases with gold active words and no size animation. It is an
editorial preview, **not** a pixel-identical Remotion render or a web-flow test.
Remotion cannot start in the current workspace because `os.networkInterfaces()`
fails with `uv_interface_addresses`; this review does not change that environment.

The MP4 is 1280×720 at 30 fps for review. The sonar source is only 640×360, enlarged
to 720p; improve or replace that source before final 1080p production if its detail
is insufficient. Other NOAA sources are 720p, and the reused AI sources are 1080p.

## Remaining integration

Review artifact verified: H.264/AAC, 1280×720, 30 fps, 29.200 seconds,
14,473,803 bytes. Twelve extracted frames were visually inspected for caption
legibility, credit placement and scene content. Measured audio: −16.19 LUFS,
−2.28 dBTP. The 88 caption words retain the original synthesis timestamps. This
is a frame/measurement review, not a listening review.

After editorial review, port these scene decisions and source provenance into the
production manifest/importer and the existing Remotion composition. Integrate
caption highlighting with the web readiness changes in PR #19, then run the actual
web renderer. Do not treat this preview as evidence that those integrations or
the complete documentary are finished. The revised full-episode budget remains
unapproved.
