# Preventive spending controls

The production web app and standard worker require the same service-only Supabase
admission functions. Paid script, voice, avatar, image, video and generative music
calls reserve provider capacity and cash before submitting. Missing policies,
stale balances, missing rates and exhausted limits fail closed.

Whole-job envelopes are reserved before the render attempt transition and reused
by the same attempt. Calls consume those envelopes without double counting. Only
unused envelope resources are released; ambiguous paid operations retain their
funding and cannot be automatically repeated. Worker claims retain the original
request, owner and attempt fence. Supply waiting remains a durable processing
state and does not become a stale-render retry.

Provider limits are separate from a replenishment reserve or bank funds. No
transfer, purchase, recharge, advertising allocation or new provider activation
is performed by this change. Financial quota estimates remain advisory and show
unknown where rates or settled funds have not been verified. Alert delivery is
exclusively the private owner/admin panel, including when legacy webhook variables
are present. Automatic queue resumption is disabled by default; the existing
hourly read-only monitor schedule is unchanged.

## Validation

- `npm run test:spend`: policy, gate, ledger, queue, notification destination and
  obligation regressions; fixtures only, no paid provider calls.
- TypeScript and focused ESLint verification.
- Supabase rollback-only fixtures: 50 call admissions with three slots; 50 job
  reservations with a protected critical balance; atomic multiple-provider
  reservations; 50 worker claims; duplicate prevention, stale/future evidence,
  closed free pool, global and provider ceilings, release of unused resources.
- Separate exact daily-cap fixture: an uncertain 19.50 plus a new 0.50 fits a
  20.00 cap; an additional 0.51 is denied before provider submission.
- Existing generation regressions use injected durable ledgers and synthetic
  media; a missing paid result is not purchased again.

## Activation status

Integration of a gate is distinct from permission to fund it. Global daily and
monthly funded budgets, provider monthly caps, verified rates and concurrency
must be configured before paid generation can be enabled. A replenishment reserve
must never be substituted for these missing settings. This integration intentionally
keeps unconfigured providers closed and performs no paid end-to-end generation.
Authenticated visual acceptance of the production dashboard remains a separate
check; a READY deployment and fixture tests do not claim that acceptance.
