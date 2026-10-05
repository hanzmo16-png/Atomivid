# SaaS launch readiness — 2026-10-05

## Verified

- Existing reel playback/download manually confirmed by owner; exact-file technical delivery audit passed. See REEL_DELIVERY_VERIFICATION.md.
- Existing beta black-shirt avatar technical audit passed 11/11 checks; owner manually approved face, voice and lip synchronization. See AVATAR_DELIVERY_VERIFICATION.md. No new avatar generation.
- 148 local flow tests passed for visual reels, avatar, Long Form, logos and progress; 42 additional local billing/quota/telemetry tests passed. Explicit doubles/fixtures: these do not certify production transactions or live generation.
- Vercel connector rechecked READY Preview `dpl_DJcQE8aicnniS7BbQZ6kQCuyQjVx`, functional commit `20e137529c3577172f8f2acb8d4f67fdb34fb86a`.
- Latest READY production remains `dpl_9z8MPoGnHhGpVuY6MWUe8Qh93vCi`, commit `b76db2a608ed74ee1141e0c5e41746f2aaed6706`, branch `claude/atomivid-mvp-setup-0079jv`. Public alias `atomivid.vercel.app` was independently returned by the connector. Tested corrections have not been promoted.
- Read-only Supabase check: beta has an active/trialing subscription; principal does not. Beta has zero processing/completed normal and avatar requests created since the Cancun October month boundary. Provider capacity, configured Stripe price mapping and remaining credits have not been certified by these facts.

## Remaining acceptance criteria

1. A NEW owned request through the authenticated form, script review and actual render-admission click; observe live stage/progress, final delivery and reload persistence. Completed accepted requests must never be reset or reused as evidence of a new flow. Preserve subscription and budget controls; the immutable old one-request trial cannot fund a new request.
2. Verify deployed reviewed-visual settings for the page AND its worker, together with provider capacity/cost configuration; isolated trial settings do not establish general rollout. Live customer-logo inclusion, new avatar admission and normal Long Form production/delivery still need applicable scoped evidence.
3. Review/publish the corrected application to production and repeat critical checks there. Verify a customer signup/confirmation, checkout/webhook entitlement, quota counting and cancellation in the intended Stripe mode. Local doubles and a beta subscription are not payment-integration proof. Do not silently alter Stripe state or grant accounts subscriptions.

## Precampaign proposal (not executed or spend-authorized)

Recommend one Meta Ads Manager campaign using Facebook and Instagram, initially Mexico, Spanish creative, one broad audience with 25–55 as an initial age hypothesis, all genders. Creative/copy should qualify people who need recurring reels for their business. The audience hypothesis is not evidence of buying propensity, and actual control availability must be checked in Ads Manager.

Recommend MXN 2,100 advertising budget over seven days (MXN 300/day equivalent), configured as a fixed total with end date; verify account currency, taxes and final checkout. This is our proposed experiment, not Meta pricing, guaranteed volume or existing advertising authorization. Avoid fragmenting this initial spend among countries or paid platforms.

For precampaign, propose the Leads objective with a native Meta form inviting launch interest. Ask contact details and intended use (business, clients, own channel); verify an appropriate privacy link and handling before publication. Evaluate qualified/contactable leads and later activations and paid subscriptions, separately from views/likes. Reuse the owner's approved campaign video; no asset modifications, external messages, ad creation, publication or purchases were performed in this readiness pass.

Official public guidance reviewed: https://www.facebook.com/business/ads/facebook-instagram-reels-ads and Meta Blueprint https://www.facebookblueprint.com/student/activity/707407 (Reels creative and instant-form lead quality). Some Meta pricing/help pages were inaccessible to automated retrieval; no country CPM/CPL benchmark or guaranteed return is claimed.
