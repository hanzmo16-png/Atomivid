# Literal visual matching in reels

The alien reel exposed two independent defects. Its operator-authored queries
requested reptiles, moon surfaces and generic space footage instead of alien
figures. The stock selector then ranked resolution, duration and diversity without
inspecting pixels. A technically attractive iguana could therefore win.

New script output includes a `visualIntent` for every scene: actual subject,
required visible traits/actions, forbidden substitutes, a stock/illustration choice
and a self-contained generation prompt. Queries vary the camera or setting while
preserving the subject. Fictional creatures and historical reconstructions use
illustrations, explicitly distinguished from documentary evidence.

The reviewed reel path is enabled by `REEL_VISUAL_RELEVANCE_ENABLED=true`.
It validates illustration capacity before TTS, requires updated visual plans and
uses the existing rendering, captions, voice, music and customer-logo components.
Legacy scripts must regenerate their visual plan; manually editing narration or
queries invalidates that plan. Avatar and Long Form rendering are unaffected.

Stock candidates are decoded from the actual downloaded bytes. Before paid review,
static raster images must retain at least 720×1280 native pixels after the vertical
cover crop (before camera zoom). A large landscape width does not qualify a blurry
vertical crop. Corrupt, undersized, animated/vector images and too-short clips are
rejected as defective candidates, without a vision reservation; selection can try
another candidate. Missing executables, timeouts, vision/provider and budget failures
stop processing. Clips use their probed video-stream duration and square pixels.

Review examines paired base and maximum-camera views using the same zoom/pan
constants as `VerticalReel`. Clips are sampled at beginning, middle and near end of
the portion used: six views in one paid call, rather than six separate reviews. GPT-4.1 mini receives the
pixels, narration and subject requirements. All required traits must pass, with
confidence at least 0.8. In addition, `subjectClear` and `compositionAcceptable` must both be true, and
`visualArtifactsPresent` must be false. The subject must remain readable and well
framed at maximum zoom, without severe blur/compression, broken geometry or
malformed anatomy inconsistent with its contract. Background bokeh, deliberate
portraits and the specified anatomy of fictional beings are allowed. Every supplied
view must pass; attractive or relevant material cannot compensate for another
failed criterion. Technical scores cannot override a failed verdict. Missing
or failed vision checks stop processing. No search is truncated into broader words
in reviewed mode. A generated illustration must pass the same check; rejected
illustrations are not silently replaced by unrelated stock or automatically
regenerated. A verified subject is required in every sampled view; sampling does not establish continuous visibility.
Reviewed illustration requests disable automatic provider retries, including
ambiguous HTTP/network failures, so each ledger submission makes one image call.

There are at most six checked candidates per scene and twenty paid reviews per
request, including failures and uncertain submissions. The database atomically
reserves $0.005 per review, for a $0.10 review ceiling. The fixed model is
`gpt-4.1-mini-2025-04-14`; the reviewed official model documentation lists $0.40/M
input tokens and $1.60/M output tokens. Prompts and frame sizes are bounded;
views are 512×910 JPEGs at quality 90 and output is capped at 512 tokens. A
conservative estimate of bounded image/text/output tokens is checked against the
existing $0.005 reservation before submission, using the official 32-pixel patch
rules and the fixed model's 1.62 multiplier. This does not change the per-request
$0.10 review ceiling. Exact usage/cost and immutable cached verdicts
live in the existing paid ledger and private result storage. Retries of unchanged
media and requirements reuse the verdict. Changed requirements or media invalidate
it. Policy `literal-visual-quality/2`, an instructions hash and the actual reviewed
pixels are included in the key. Old relevance-only verdicts lack required quality
fields and cannot authorize this gate; an invalid persisted verdict stops without
silently purchasing another review. Vision failure is never treated as acceptance.

Image generation remains subject to `OPENAI_IMAGE_GENERATION_ENABLED`,
`IMAGE_PROVIDER=openai`, `MAX_GENERATED_IMAGES_PER_VIDEO` and `MAX_VISUAL_COST_USD`.
Its existing provider cost is an estimate, not a new guaranteed tariff. Generation
and reviews are separately recorded in the paid ledger; aggregate visual cost
includes both. A voice-only `owner-pilot/1` grant cannot authorize this paid path.

GitHub worker rollout variables (unset = off):

| Repository variable | Worker setting |
| --- | --- |
| `REEL_VISUAL_RELEVANCE_ENABLED` | `REEL_VISUAL_RELEVANCE_ENABLED` |
| `REEL_IMAGE_GENERATION_ENABLED` | `OPENAI_IMAGE_GENERATION_ENABLED` |
| `REEL_MAX_GENERATED_IMAGES` | `MAX_GENERATED_IMAGES_PER_VIDEO` |
| `REEL_MAX_VISUAL_COST_USD` | `MAX_VISUAL_COST_USD` |

The worker receives the existing OpenAI secret only when this reviewed path or
Long Form is enabled. Match the settings in any inline execution environment.

## Verification limits

The regression suite exercises wrong-subject rejection for aliens, animals,
food and historical scenes; acceptance criteria; actual PNG decoding/cropping, EXIF rotation, native crop resolution, zero paid
reservations for corrupt/undersized files, maximum camera framing, and
extraction of beginning/middle/end frames from a locally encoded MP4;
provider/ledger failures; persisted verdict reuse and changed-plan invalidation.
These tests use explicit model-response doubles. They prove orchestration and
gates, not real-model accuracy. The database reservation test exercises all twenty
reservations, the twenty-first refusal and idempotence inside a transaction that
is rolled back. No paid inference or image generation is performed for these tests.

A paid isolated trial completed on 2026-10-04 (Actions run `37222747262`,
request `4a3af8e9-17e6-45ef-ade4-cac80be6c1d2`). The owner authorized at most
six illustrations and twenty reviews with an estimated $0.40 visual budget,
without voice calls or live rollout. Real Pexels iguana and light-bulb images were
correctly rejected against reptilian-humanoid and grey-alien requirements. Six
generated illustrations passed the production relevance gate: grey, reptilian,
Arcturian, Pleiadian and Urmah characters, and tacos al pastor. Human inspection
confirmed the defined subjects and traits. The silent 30-second vertical preview
and six-image contact sheet are review artifacts, not a full narrated reel.

The first attempt exposed an overly long model explanation rejected by local
validation. The corrected contract caps explanations, normalizes their display
length and saves raw provider responses before parsing. All three existing paid
images were reused. There were six image calls and thirteen vision submissions
across both attempts. One original vision submission remains explicitly
`RECONCILIATION_REQUIRED`; its $0.005 reservation is retained. The ledger totals
$0.3402 in system-calculated committed costs plus that reservation, or $0.3452
accounted. Image pricing is an estimate, not a verified provider invoice. The
human-reviewed deliverable moves titles below faces using the same saved images
and no additional paid inference.

This trial used six fixed visual contracts. It does not validate automatic
script planning, narrated rendering or every possible topic. The general feature
flag remains off; production was not activated. The quality/2 refinements were verified with 49 focused tests and the full
1,629-test unit suite, plus TypeScript and ESLint. These added quality verdicts use
model-response doubles; the earlier paid trial tested relevance/1, not quality/2.
Avatar and Long Form do not use the new semantic/quality review. Their existing
pipelines and motion requirements remain unchanged. This is a focused reels change,
not certification of every existing product function.

Vision can make mistakes; three time samples do not prove every frame of a clip. It cannot
authenticate the identity of a real person or prove historical accuracy. Passing
the gate is a quality check rather than a promise of perfect relevance for every
possible topic.

Official references:
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs
