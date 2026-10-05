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

## Supply readiness — implementation update

See [PROVIDER_SUPPLY_CONTROLS.md](PROVIDER_SUPPLY_CONTROLS.md) for the preventive operating plan, atomic whole-job supply/cash reservation, provider/worker concurrency, 30% / 72-hour alerts, durable waiting and reconciliation. Policies remain OFF with unfunded ceilings; no recharge, ad purchase or paid generation was performed. This does not replace live account/budget/notification/deployment acceptance.

## Precampaign proposal (not executed or spend-authorized)

Use one Meta Ads Manager experiment across Facebook and Instagram, with an overall MXN 2,100–4,200 funded ceiling and an end date. Start with the Spanish-language market hypothesis (Spanish-speaking customers in the United States and Spain); English-language expansion requires an English landing/demo and product readiness. This is a test hypothesis, not proven country-level profitability. Do not split the initial budget across multiple paid platforms.

The precampaign should collect launch interest through a demonstration of existing results. No two free videos; no unlimited free generation. Any future short promotional sample needs a separate per-user limit, total redemption cap and funded cost ceiling. Keep the SQL free pool at zero until then. Advertising money is separate from provider/infra funds; sales receipts can be reinvested once actual costs and obligations are measured.

Measure qualified leads, activation, paid conversions and continued use. Verify the privacy notice and intended handling before collecting leads. No ads, external messages, purchases or audience settings were published by this work.
