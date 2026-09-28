# Runway integration for Long Form

Prepared 2026-09-27 (Cancun). This change is based on the current default branch and excludes unrelated Dulce/ocean feature branches.

## Behavior

- Gen-4 Turbo image-to-video, API version 2024-11-06, 720p, 5/10-second adapter requests. The Long Form planner reserves 10 seconds / USD0.50 per animated shot, covering the existing 3–8 second editorial slots. Other callers can still request 5 seconds / USD0.25.
- Preview and confirmation read VIDEO_PROVIDER. The worker uses the confirmed plan's provider rather than switching an existing Veo plan to Runway.
- A Runway plan with allocated clips fails before paid narration/images if its connection is unavailable.
- Accepted task IDs persist before polling. For Runway, a write-ahead STARTED marker also prevents resubmission after an ambiguous POST without a task ID. That state requires reconciliation; the user must not delete it just to retry.
- Existing completed outputs are reused. Pending operations cannot be resumed against a different provider.
- RUNWAY_API_KEY is available to the Long Form worker only through GitHub Actions secrets. No secret or live default changes are included in this commit.

## Activation still required

1. Create a Runway API key for project atomivid and securely configure RUNWAY_API_KEY in GitHub Actions. The browser requires action-time confirmation for creating a persistent credential.
2. Deploy this change and set VIDEO_PROVIDER=runway on the planning server with PREMIUM_CLIPS_ENABLED=true and LONG_FORM_AI_VIDEO_ENABLED=true. Keep Veo configured for its existing confirmed plans. There is no automatic paid failover in this change.
3. Execute a single confirmed application request within an approved budget, then verify the actual MP4 and cost. Tests use mocked providers and do not establish live app/API operation.

## Account observation and ten-minute Dulce feasibility

Observed in Runway Dev on 2026-09-27: 425 credits remaining, autobilling disabled, Usage tier 1, Gen-4 Turbo concurrency 1 and 50 generations per rolling 24 hours. No API keys existed. Three previously completed five-second clips used 75 credits.

At 5 credits/second and USD0.01/credit, remaining balance covers 85 new seconds. Ten minutes of wholly new animation requires at least 60 ten-second clips (USD30), before trims/rejected material. A planning allowance of 20% extra generated footage raises it to 72 clips / USD36; this is a planning assumption, not a measured acceptance rate. Reference images, voice and other costs are additional. Existing footage can reduce needs, but does not resolve today's tier-1 limit for a fully animated ten-minute episode.

Official usage tiers document immediate tier 2 after USD50 purchased: 500 video generations/day, concurrency 3, USD500 monthly credit-purchase cap. This is a credit purchase, not a subscription or the episode's actual cost. No purchase was made or authorized in this change. The full ten-minute Dulce script is not ready; the existing pilot narration is ~39 seconds. No same-day delivery guarantee.

The current product's cinematic preset remains selective animation (20% by default). A fully animated channel episode requires its own explicit storyboard and budget; this change does not silently convert ordinary user orders to 100% animation.

## Validation

Focused tests cover adapter request contract, fractional editorial durations, provider-specific pricing, pinned provider selection, ambiguous submission recovery, and the Long Form pipeline with Runway-shaped mocked outputs. TypeScript checked after Next route type generation. Live API/app validation remains pending.

Sources: https://docs.dev.runwayml.com/guides/pricing/ and https://docs.dev.runwayml.com/usage/tiers/ ; account-specific limits read from the authenticated Usage page.
