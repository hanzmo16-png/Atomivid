# VFX Director V1 — planning and zero-cost execution core

Implementation: `src/lib/production-intelligence/vfx-director/index.ts`.

The director extends Production Intelligence's ShotContract, stable fingerprint and project reservation. It does not change existing motion fallbacks, payment gates, database schema, approved videos or production routes.

`direct()` accepts a host-provided planning transport, supplies the director instructions, and parses the returned plan. `compilePlan()` validates source identity, duration, frame beats, executor availability, subject preservation, task order, inputs and non-destructive output identities. `execute()` revalidates and runs registered zero-cost executors sequentially, stopping on an output mismatch or executor QA failure. `review()` requires every requested check with evidence, no failing finding, and explicit human approval.

## Current boundary

### Approval gates

Planner responses are now strict `PLANNED` (with plan), `NEEDS_MATERIAL` (reason and material), or `REJECTED` (reason and alternative). Every task has an explicit stage; each host executor separately declares allowed stages, so a model cannot label a final compositor as preview to bypass checks.

Final composition requires recorded direction, styleframe, motion and integration approvals. Delivery additionally requires master approval. Each approval must match both the current compiled plan hash and the reviewed artifact SHA-256, name a reviewer and contain all required checks with passing evidence. A later rejection of the same artifact invalidates its earlier approval. Centered framing is not an automatic defect. Evidence is supplied by a trusted host review service, not by the model; this module does not authenticate reviewers or persist approvals yet.

Preview material can be produced before visual approval, but paid executors remain blocked. Stored plans, resumable task state, double-click protection and tenant authorization still require worker/API integration; these gates do not claim to implement those features.

This is a tested library core, not a deployed product capability. No live model transport, production compositor adapter, persistent execution store or UI has been connected. Executor capabilities and check evidence are trusted host inputs, not independently measured by this module. Fixture tests do not prove visual quality. Paid executors are blocked until they are routed through existing gated paid calls and the durable ledger. Do not use the local zero-cost runner for durable retries or billable work.

## Opening recipe to validate next

Keep the approved product navigation, audio and captions. Inspect the full-resolution review master first to distinguish proxy compression from plate/crop degradation. Plan the existing opening slot as room → Times Square → beach → moon; do not extend voice timing without checking the edit. Resolve source framing, cropped plate pixel density, perspective, lighting and subject lock before production. A lunar setting is deliberately fantastical; its world contract must explicitly state the presenter's physical treatment.

Required visual checks: source subject preservation, plate crop resolution, moving background, shoulder/hair edges, occlusion, lighting integration, transition readability, caption clearance and continuity into the approved UI segment. Every check needs actual evidence. Export only a separate review master for human approval.

## Remaining integration

1. Connect the existing model adapter to `direct()` using structured output; model output is untrusted and cannot set capabilities or prices.
2. Wrap the VFX-002b compositor with measured media validation; return real output fingerprints and QA evidence.
3. Route any generated plates through existing paid-call gates, capacity checks and durable ledger, then add resumable worker persistence.
4. Execute the opening benchmark and review the moving full-resolution result. Until then, make no claim of photoreal success or autonomous perceptual QC.

Verification: `node --import tsx --test src/lib/production-intelligence/vfx-director/index.test.ts`; also registered in `test:unit`.
