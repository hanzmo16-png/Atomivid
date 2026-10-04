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

Stock candidates are decoded. Images are center-cropped to the vertical viewport;
clips are reviewed at two points from the portion used. GPT-4.1 mini receives the
pixels, narration and subject requirements. All required traits must pass, with
confidence at least 0.8. Technical scores cannot override a failed verdict. Missing
or failed vision checks stop processing. No search is truncated into broader words
in reviewed mode. A generated illustration must pass the same check; rejected
illustrations are not silently replaced by unrelated stock or automatically
regenerated. A verified subject remains visible throughout its scene.
Reviewed illustration requests disable automatic provider retries, including
ambiguous HTTP/network failures, so each ledger submission makes one image call.

There are at most six checked candidates per scene and twenty paid reviews per
request, including failures and uncertain submissions. The database atomically
reserves $0.005 per review, for a $0.10 review ceiling. The fixed model is
`gpt-4.1-mini-2025-04-14`; the reviewed official model documentation lists $0.40/M
input tokens and $1.60/M output tokens. Prompts and frame sizes are bounded;
output is capped at 384 tokens. Exact usage/cost and immutable cached verdicts
live in the existing paid ledger and private result storage. Retries of unchanged
media and requirements reuse the verdict. Changed requirements or media invalidate
it. Vision failure is never treated as acceptance.

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
food and historical scenes; acceptance criteria; actual PNG decoding/cropping and
extraction of distinct frames from a locally encoded MP4;
provider/ledger failures; persisted verdict reuse and changed-plan invalidation.
These tests use explicit model-response doubles. They prove orchestration and
gates, not real-model accuracy. The database reservation test exercises all twenty
reservations, the twenty-first refusal and idempotence inside a transaction that
is rolled back. No paid inference or image generation is performed for these tests.

A paid visual trial and human review are still required before activation. Vision
can make mistakes; two frames do not prove every frame of a clip. It cannot
authenticate the identity of a real person or prove historical accuracy. Passing
the gate is a quality check rather than a promise of perfect relevance for every
possible topic.

Official references:
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs
