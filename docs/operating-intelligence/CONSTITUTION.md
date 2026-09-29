# ATOMIVID — Operating Intelligence Constitution

Status: contract. This document binds every current and future intelligence layer of ATOMIVID
(Production Intelligence, Business Telemetry, and the future Finance, Growth and Executive
Intelligence). It is documentation, not code: nothing here grants any system the ability to
execute a financial action.

## Principles

1. **SINGLE SOURCE OF TRUTH.** Every fact has exactly one canonical owner. Cost Engine owns
   cost. Production owns production state. Final Cut owns editorial state. Distribution owns
   YouTube facts. Billing (Stripe, when it exists) owns revenue. Telemetry records events and
   relations; it never keeps a second set of books.
2. **DEFINITIONS BEFORE DASHBOARDS.** A number is shown only after its definition (source,
   window, unit, currency, inclusions and exclusions) is written down and tested.
3. **UNKNOWN != ZERO != HEALTHY.** Missing data is UNKNOWN or UNAVAILABLE, never 0. A system
   with no observed successful write is UNKNOWN, never HEALTHY.
4. **OBSERVED != PROJECTED.** Observed facts and projections live in separate structures with
   separate names. V0 stores observed facts only; a prediction is never a `business_event`.
5. **RESERVED CASH BEFORE REINVESTABLE CASH.** Obligations, reservations and provider balances
   are subtracted before any amount is called reinvestable. A provider top-up is capacity,
   never cost of goods sold and never free cash.
6. **CONFIDENCE GOVERNS LANGUAGE.** A figure derived from a verified source is stated; a figure
   derived from an estimate is labelled; a figure that cannot be derived is not shown.
7. **COLLECT EARLY, AUTOMATE LATE.** Facts are collected from the first day with idempotent,
   append-only, versioned events. Automation is added only after the facts have been observed
   long enough to define it.
8. **RECOMMENDER != EXECUTOR.** A layer that recommends never holds the credential that
   executes. No intelligence layer holds a payment, ad-platform, bank or provider-billing
   credential.

## Levels (future)

| Level | Name | What the layer may do |
| --- | --- | --- |
| L0 | OBSERVE | Record and show observed facts (Business Telemetry V0 lives here). |
| L1 | ANALYZE | Derive definitions from facts (margins, cohorts, retention) with stated confidence. |
| L2 | RECOMMEND | Propose actions with evidence; a human reads and decides. |
| L3 | SIMULATE | Model the effect of a proposed action without executing it. |
| L4 | HUMAN-APPROVED EXECUTION | Execute one explicitly approved action, logged, reversible where possible. |
| L5 | BOUNDED AUTO-EXECUTION | Execute within pre-approved bounds, with kill switch and audit. |

## Initial setting

```
AUTO_EXECUTE = FALSE
```

The constant `AUTO_EXECUTE` in `src/lib/business-telemetry/index.ts` is `false` and is tested.
Raising the operating level requires a new, explicit, written human decision per level; no
code path may raise it. Prohibited in every layer until such a decision exists: marketing or
budget recommendations acted on automatically, automated ad spend, payments, provider
payments, refunds, bank transfers, automatic reinvestment, automatic campaign changes.

## How Business Telemetry V0 feeds the future layers (document only)

- **FINANCE INTELLIGENCE.** Cost Engine (actual COGS per production/provider/shot) +
  `provider_consumption_recorded` events → obligations/reserves (paid-operation ledger) →
  margin (requires revenue facts from Billing) → reinvestable cash (after reserves). Not built.
- **GROWTH INTELLIGENCE.** Attribution touches (first/last touch) → `user_registered` →
  activation (`production_requested`) → payment (`payment_succeeded`, pending Billing) →
  retention/cancellation → CAC / payback / LTV. Not built; no attribution model beyond
  first/last touch evidence exists.
- **EXECUTIVE INTELLIGENCE.** Production + Final Cut + Distribution + Finance + Growth on one
  surface, each figure carrying its confidence. Not built.
