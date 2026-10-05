# Internal production readiness — 2026-10-05

This isolated change carries the private documentary language selector from PR #31 and the provider-evidence corrections from PR #32 onto production after PR #33. It does not include the larger supply-controls/financial stack from PR #30.

## Included

- Private documentary form offers Spanish and English. The server rejects unsupported languages before script generation, passes the chosen language to the script provider and saved request, and preserves it on recoverable form errors.
- Command Center checks provider observations against the server clock. Evidence older than five minutes, future/invalid timestamps, invalid quantities and non-API observations do not certify current capacity.
- Registered providers without observations remain visible as UNKNOWN. Missing registry data cannot produce a READY provider summary.
- USD values preserve cents. RECONCILIATION_REQUIRED operations in the selected reporting window remain in reserved amounts, separate from confirmed provider consumption.
- The panel-only alert inbox from PR #33 remains intact. Its hourly billing observer does not replace a fresh per-job admission check. Historical alerts and expired balance evidence are different views of the same operation.

## Validation

55 focused tests passed for the form/parser, documentary script preconditions, access gates, provider aggregation, rendered dashboard and private alert inbox. Next route type generation, TypeScript, focused ESLint and whitespace checks passed. No paid script, narration, image or video generation was performed. These tests do not certify a new production through the authenticated form.

## Still required before autonomous internal production

1. Confirm the intended account's existing entitlement/private access and define a bounded, funded test. Do not grant a subscription or reuse a completed one-request trial as new quota.
2. Review the wider supply-controls stack and coordinate the application with its actual worker ref before activating it. Keep automatic job resumption off until fresh evidence, reservations and the worker are verified together.
3. Verify planning rates, account resources and aggregate daily/monthly budgets. A proposed per-provider ceiling is neither prepaid balance nor an aggregate budget.
4. Execute one new authorized request from authenticated form through script review, production, playback, download and reload persistence. Preserve existing accepted masters.
5. Keep public launch separate from this acceptance: checkout, entitlement/webhook and cancellation still require live evidence in the intended billing mode.
