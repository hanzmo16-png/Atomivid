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
another candidate. Missing executables, system errors, timeouts, vision/provider and budget failures
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
flag remains off; production was not activated. The quality/2 refinements were verified with 50 focused tests and the full
1,630-test unit suite, plus TypeScript and ESLint. These added quality verdicts use
model-response doubles; the earlier visual-only paid trial tested relevance/1, not quality/2.
Avatar and Long Form do not use the new semantic/quality review. Their existing
pipelines and motion requirements remain unchanged. This is a focused reels change,
not certification of every existing product function.

A second isolated trial completed on 2026-10-04 through the actual
`generateVideoFromScript` production render stage, using quality/2 (Actions
`37232968501`, commit `9e30e0ceeef12f455a6f99bf0fefd3bef6b311a8`, request
`40b04013-986f-4621-bfc2-4cf0f265287d`). Its separate immutable authorization
allowed five images, twenty reviews and two prepaid voice calls, with a $0.65
accounted-cost ceiling. Old voice-only grants and the first closed trial were
not reopened. An atomic request claim prevents another paid execution; completed,
failed or previously claimed requests stop without paid replay. The general
feature flag remains off.

The new trial used a frozen five-scene Spanish script, explicitly about fictional
grey, reptilian, Arcturian, Pleiadian and Urmah characters. It validates narrated
rendering from an approved script, not automatic script generation or API billing
admission. Real iguana and light-bulb controls were rejected. Five newly generated
illustrations passed both the base vertical crop and maximum camera framing under
the new subject/clarity/composition/artifact verdict. The final MP4 contains the
five matching subjects, real ElevenLabs narration with word-timed captions,
curated music and loudness mastering. Human inspection of seventeen time samples
confirmed matching subjects and readable captions; a complete local FFmpeg decode
found no media errors. This is positive evidence for this reel, not every topic.

Output: 1080×1920 H.264 at 30fps with AAC audio, 33.3 seconds (within the current
30-second narration tolerance plus the half-second tail), 9,088,562 bytes.
Measured loudness: −16.21 LUFS, −1.54 dBTP. There were five image submissions,
seven vision submissions and one voice submission, all COMMITTED. The system
ledger accounts $0.2796 for images, $0.0070 for reviews and $0.0496 estimated voice
cost, $0.3362 total. These are system-calculated estimates, not an invoice.
ElevenLabs was checked active with overage disabled before and after execution;
the subscription's included balance changed from 18,254 to 18,056 credits.

The trial exposed misleading legacy diagnostic scoring: generated illustrations
do not populate the Pexels source-ID set, and one subject per narration segment
does not follow the old 1.8–3.8-second stock-beat rule. The diagnostic now records
the actual reviewed/planned scene counts, composition policy and narration
duration result on the reviewed path; the old score still applies to the legacy
stock-beat path. This diagnostic-only correction does not change the rendered
trial or weaken visual acceptance. Stock fallback under quality/2, automatic
planning, Avatar and Long Form still need separate real-flow validation before
claiming broad product coverage.

Two stock-footage trials on 2026-10-04 exercised the same production render stage
with a frozen four-scene Spanish business script. The first (Actions
`37235563961`, request `9f0c276e-2cc2-440e-9f8c-3fbdd047974a`) passed technical
checks but was rejected during manual pixel inspection: the last accepted clip
showed cryptocurrency/candlestick trading screens while the narration discussed
customer inquiries, purchases and service costs. Four stock clips, six reviews
and two voice submissions accounted for $0.1112. The request was marked failed
for final visual QA; its output and immutable paid receipts remain preserved.
The model's confident initial verdict was not treated as proof of suitability.

The planner instructions and vision system now require matching the narration's
domain as well as the literal subject. Business sales/customer reports must not
be substituted with financial-market or cryptocurrency trading. The instructions
hash is already part of the review fingerprint, so the corrected instructions
cannot silently reuse verdicts from the old prompt. The final scene's frozen
visual contract and search terms were also made specific to business reports.

The corrected trial (Actions `37236428790`, worker commit
`52363f2bbaf6b7a9aa63cf1c56f642c50c3003e1`, request
`c661d874-f383-4230-9bd9-449d6722ef80`) explicitly rejected the original trading
clip as a real negative control. It rejected another insufficient report clip
and selected four stock videos showing notebook planning, a business discussion,
product-order preparation, and printed business reports. No generated images
were needed. All six new paid reviews are COMMITTED, accounting for $0.0132;
both stock attempts together account for $0.1244, including estimated voice cost.
These figures are system estimates, not provider invoices.

There were zero new voice calls in the correction. Its immutable grant forbids
them. The isolated runner verifies the original owner, exact narration text,
voice/model/settings and paid-operation fingerprints, then validates audio SHA,
byte length and word timings before referencing the existing paid audio. An
internal zero-cost reuse receipt records provenance; it does not fabricate a
new committed TTS payment or reopen the failed request. This is scoped trial
reuse, not a new customer-facing cross-request cache feature.

Corrected output: 1080×1920 H.264 at 30fps, AAC, 28.6 seconds, 7,179,953 bytes;
−16.25 LUFS and −1.47 dBTP. Manual visual inspection of fourteen timeline
samples, the four narration-aligned scene frames and the last scene at full
resolution confirmed suitable report imagery without trading screens. A complete
local FFmpeg decode found no media errors. TypeScript, ESLint and 45 focused
tests passed locally; the worker's checks and all four concurrent read-only CI
workflows passed. The general flags remain off and production was not deployed.

This supplies real quality/2 stock-selection evidence for one business script.
Automatic script generation and API admission still need end-to-end validation.
The stock-to-AI fallback was not invoked in this stock trial; separate real AI
illustration and stock trials do not prove that combined fallback in a live
request. Avatar and Long Form remain outside this semantic-review change.

The subsequent form-to-render audit found conflicting schema instructions: the
visualConcepts description still requested different interpretations despite the
literal-subject prompt. Both now preserve the same subject and domain. Manual
PATCH edits retain only the server's plan for unchanged narration and search
alternatives; changed scenes lose that plan. With reviewed reels enabled, the
review UI explains which scene to regenerate and disables generation, and the
render API independently rejects the missing plan before quota, state mutation
or worker dispatch. Scene regeneration first saves pending edits so it works
from the current narration. Inputs and render controls lock during that operation.

Script POST/PATCH no longer announce saved success when the database reports an
error or their conditional state update loses a race. Successful-provider usage
is recorded before saving, and failed generation cannot clear a request that has
already moved to a different status. Behavioral tests execute actual HTTP handlers
with explicit auth/database/provider doubles and render the real review component;
these are zero-spend integration checks, not live authentication or model evidence.
The deployed browser was signed out during this audit. A complete authenticated
form-to-provider test remains pending; no subscription or auth gate was bypassed.

Vision can make mistakes; three time samples do not prove every frame of a clip. It cannot
authenticate the identity of a real person or prove historical accuracy. Passing
the gate is a quality check rather than a promise of perfect relevance for every
possible topic.

Official references:
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs
