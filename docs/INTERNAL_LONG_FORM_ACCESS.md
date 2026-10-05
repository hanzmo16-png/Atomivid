# Internal Long Form production

The owner authorized a production-only grant on 2026-10-05 for the confirmed
account used in the application. Its private auth UUID is configured in
`INTERNAL_LONG_FORM_USER_ID`; no personal identifier is committed here.

The grant permits the normal Long Form form and confirmation route and replaces
the retail subscription requirement for that account's Long Form requests only.
It creates no Stripe subscription or database subscription record. It grants no
avatar, short-video or admin access. Missing configuration, another identity,
an unconfirmed account and a mismatched request owner remain denied.

The render route still reserves whole-job funding and claims a worker atomically.
Each provider call still uses the durable paid-operation and supply gates. Global
and provider daily/monthly ceilings, fresh balance and rate requirements, critical
credit buffers and uncertain-charge reconciliation are unchanged. This grant is
not evidence that a supplier is enabled or funded.

Removing the server-only UUID revokes this internal entitlement on redeployment.
