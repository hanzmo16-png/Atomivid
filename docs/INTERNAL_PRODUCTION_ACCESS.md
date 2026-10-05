# Internal owner production

The owner explicitly authorized an active internal owner/admin account on
2026-10-05 to produce content at supplier cost. Its confirmed auth UUID is stored
only in the production-scoped server variable `INTERNAL_PRODUCTION_OWNER_USER_ID`.
No personal identifier is committed here.

The entitlement supports the existing visual/reel, Long Form and avatar modes,
including their existing narration options, and grants Command Center access.
It creates no Stripe customer, subscription or fabricated subscription record.
The billing page shows an active internal Owner plan without a retail purchase
button, and the checkout action rejects an accidental retail checkout for the
owner. Customers keep their existing plans, subscription checks and quotas.
Standalone audio/podcast production and direct publishing are not yet integrated.

The authenticated confirmed account must match the configured UUID and own the
request. Other users, missing or malformed configuration and unconfirmed accounts
remain denied. Removing the UUID revokes the internal grant on redeployment.
Existing separately configured legacy beta/admin grants are preserved.

The grant replaces retail entitlement only. Whole-job funding, atomic worker
claims, per-call durable reservations, global/provider daily and monthly cash
ceilings, fresh balance/rate requirements and uncertain-charge reconciliation
remain unchanged. It does not enable or fund any provider. Costs remain supplier
consumption estimates until supported by provider settlement; no customer markup
or owner payment collection is introduced.
