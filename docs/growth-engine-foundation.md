# ATOMIVID Growth Engine — foundation

## First operating mode

The launch configuration is review-first. The engine may propose and prepare
content, but it cannot publish, purchase ads, change pricing, or spend provider
credits without an explicit adapter and policy allowing that action.

## Initial content pillars

1. **Product proof** — demonstrate the product with real before/after evidence.
2. **Creator education** — teach retention, hooks, visual direction, and faceless workflows.
3. **Build in public** — document the product's improvement honestly and build trust.

## Initial channels

- TikTok
- Instagram Reels
- YouTube Shorts

The same idea may be adapted across channels, but each publication remains a
separate brief so copy, timing, metrics, and later platform-specific rendering
can diverge safely.

## Safety boundary

The domain planner in `src/lib/growth/plan.ts` is deterministic and side-effect
free. It does not call an LLM, create a video, spend credits, or publish. Future
work will add adapters around this contract for:

- AI-assisted brief generation
- an approval inbox in the dashboard
- video-request creation after approval
- social-platform scheduling
- analytics ingestion and weekly learning

## Initial success metrics

- approved briefs per week
- successfully generated videos
- successful publications per channel
- three-second hold rate
- completion rate
- profile/link clicks
- trial registrations
- paid conversions

The commercial target is 25 active customers with an initial blended ARPU near
USD 42, subject to validation of real generation costs and conversion data.
