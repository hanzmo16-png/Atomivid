# Storyblocks: internal catalogue pilot

Status: preparatory integration only; NOT enabled in Reel production. No real API
request has been made, no account created, no contract purchased and no material
licensed by this change. Existing Pexels, voices, render and billing are unchanged.

## Obtain test access

Hans creates the developer account at https://developer.storyblocks.com/register.
The API offer advertises five free downloads per media type; test credentials are
restricted to internal evaluation. This script only searches and displays preview
URLs: it does not consume those downloads or grant production rights.

Store these values privately in a local ignored `.env.storyblocks-pilot` file:

```dotenv
STORYBLOCKS_KEY_MODE=test
STORYBLOCKS_API_KEY=<test public key>
STORYBLOCKS_API_SECRET=<test secret key>
STORYBLOCKS_PILOT_USER_ID=atomicvid-owner-pilot
STORYBLOCKS_PILOT_PROJECT_ID=atomicvid-historical-style-pilot
```

Never paste secrets into chat, source, PRs or screenshots. The mode is an operator
declaration, not proof of credential entitlement: only use keys labelled test by
Storyblocks. No production billing assumptions are made by this script.

```sh
node --test scripts/lib/storyblocks-pilot.test.mjs
node --env-file=.env.storyblocks-pilot scripts/storyblocks-pilot.mjs
```

Output: `.atomivid-state/storyblocks-pilot/review.html` and `catalogue.json` (ignored
by git). Six sequential search requests, up to five results each, 15-second timeout
per request, no retries. Errors stop the pilot and do not print signed URLs or raw
provider responses. Opening the HTML loads provider-hosted previews; keep it
internal. There are no paid download, licensing, render or database operations.

## Review, then decide

For each scene review actual preview frames: period/wardrobe, action, emotion,
lighting, novelty, horizontal-to-vertical crop and usable duration. Metadata does
not establish visual quality. Unknown/editorial visual rights are excluded.
Music review: solemn/epic character, intensity progression, no cheerful advertising
tone and space for narration. Do not mistake a still image pan/zoom for animated footage.

The six searches cover Roman soldiers, classical sculpture, medieval knights,
warrior contemplation, dramatic landscapes and solemn orchestral music. Empty
results stay empty; no unrelated modern fallback. The pilot reports candidates,
not automatic approval of style or quality.

The API documentation warns that API search results can differ from the website
because of licensing and experience differences. Public catalogue examples are
therefore not evidence that our test account can retrieve the same assets.

## Commercial questions before activation

Request API-specific written pricing for 100, 500 and 1,000 Reels/month, with six
visual assets plus one music track per Reel as a comparison scenario (not a sales
forecast). Ask for minimum commitment, included downloads, overage, search limits,
renewal and cancellation, customer/project reuse, caching, surviving publication
rights after cancellation, social/paid ads, YouTube claims and commercial exclusions.
State that Atomicvid is a customer-facing automated video SaaS. An individual
subscription is not the API agreement. No sales message has been sent.

Effective media cost/Reel = monthly fixed API fee / completed Reels + per-use charges.
Add this to narration, rendering and other generation costs before accepting a price.

## Production integration still required after successful pilot and contract

- Add a context-aware adapter that attributes each search and licensed download to
  its customer and video; current FootageProvider methods lack that context.
- Keep preview URLs separate from final licensed download URLs; store provenance
  and contract/license evidence. Never mark trial previews CLEARED.
- Respect budget reservations, download reuse/idempotency and ambiguous failures
  according to the provider agreement; do not invent free retries.
- Extend production config validation and Director licensing only with verified
  commercial entitlement. Introduce an off-by-default owner pilot flag.
- Enforce chosen style through search and actual frame review. Test a real owner
  Reel with default and chosen voice, subtitles, music and download before rollout.
- Evaluate music separately; this pilot does not change the existing music provider.
- Keep Pexels available during rollout, but never silently relax a chosen style.

References checked 2026-10-21:
- https://documentation.storyblocks.com/ (v2, HMAC, search parameters/response)
- https://www.storyblocks.com/resources/business-solutions/api (trial, quotation, API license)
- https://www.storyblocks.com/video/search/warrior (catalogue examples, not quality approval)
