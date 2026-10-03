# VFX Director V1 — integrated operator core

## Implemented

- Structured direction with PLANNED, NEEDS_MATERIAL or REJECTED responses. Existing Anthropic SDK/model configuration; no additional provider.
- ShotContract, canonical plan fingerprint including gate-policy version and existing budget reservation.
- Model transport through the existing durable paid-call ledger/result store. Token limits and verified operator-supplied tariff bound the worst cost before the call; zero budget blocks before network. SDK retries disabled.
- Durable Supabase snapshots with revision CAS; job owner, frozen plan, approvals, artifact hashes, completed task results, status and error are persisted.
- Dedicated runner `scripts/vfx/director-worker.ts`, registered as `npm run vfx:worker`. Plan, init, inspect, step and reconciliation actions. Existing jobs reuse their frozen plan; completed tasks are skipped. Concurrent invocations cannot claim the same task twice.
- Owner-only, feature-flagged API at `/api/admin/vfx-director` for inspection, plan replacement and review. Verified session identity is the reviewer identity. Same-origin mutations, bounded body and service-only table.
- VFX-002b compositor adapter with explicit format/identity limits, source hash verification, plate resolution/aspect/duration checks and measured output fingerprints. No silent upscale or substitution.

## Gates and evidence

Direction → styleframe (the frozen frame law) → motion → integration → review master. Every final-stage task requires all prior-stage approvals. Delivery additionally requires master approval. Approvals bind the current plan hash and artifact SHA-256 and are recorded against the authenticated owner. Replacing the plan clears prior approvals and output state. Rejected or stale reviews block advancement. Stage capabilities are registered by the host, not supplied by Claude.

Subjective reviews are explicitly human evidence, not automated claims of cinematic quality. Centered composition is not inherently defective. All failing findings block approval, even if an iteration prioritizes only three repair notes.

A RUNNING task after process death is not retried blindly. `reconcileTask()` can recover a measured existing output through an executor recovery port, after the old runner has terminated; otherwise it stays reconciliation-required. A normal caught task failure resumes that task without rerunning the planner or completed tasks. Paid generation executors remain blocked until individually integrated through existing gates.

## Runtime configuration

Use existing Supabase credentials and `AVATAR_PREPARATION_OWNER_EMAIL`. `VFX_DIRECTOR_ENABLED=1` enables owner access. The manifest is trusted runner configuration and contains owner UUID, job ID, brief, approved plan, asset identities and registered executors. It must never come directly from model or browser input.

`VFX_JOB_MANIFEST=/trusted/manifest.json VFX_WORKER_ACTION=init|plan|inspect|step|reconcile npm run vfx:worker`

For live planning only: existing `ANTHROPIC_API_KEY`, `ANTHROPIC_SCRIPT_MODEL`; operator-verified `VFX_PLANNING_PRICE_SOURCE`, `VFX_PLANNING_INPUT_USD_PER_MILLION`, `VFX_PLANNING_OUTPUT_USD_PER_MILLION`, `VFX_PLANNING_MAX_USD`. Missing/unverified pricing or insufficient budget blocks. No live planning call was made in this implementation session.

Migration `20261003141710_vfx_director_jobs.sql` applied to the Atomivid project. Verified real database revision CAS rejects stale updates and client roles lack table privileges; probe transaction rolled back. RLS without client policies is intentional for this service-only table.

## Precampaign direction — no render yet

Preserve the approved UI navigation, voice, music, captions and closing. Inspect the 1080p master to distinguish proxy compression from actual background/crop degradation. Opening concept: apartment → Times Square → beach → moon → existing UI. Do not extend the original recorded take or loop it to satisfy an invented duration.

Before rendering: measure the actual source duration/framing; assign three exact frame windows within that slot; obtain moving plates with matching framing, crop density and perspective; freeze each environment's styleframe and light treatment; approve low-resolution motion and integration. The lunar scene deliberately suspends ordinary realism and must state its world rules.

The VFX-002b adapter currently supports one plate and a fixed nighttime treatment, not a proven three-environment recipe. The director must return NEEDS_MATERIAL or reject that route until sequence-aware plate composition and environment-specific light treatments are registered. This is an explicit capability boundary, not permission to silently deliver NYC alone.

## Validation and release status

Director/worker failure tests include concurrent execution, unchanged plan on resumption, rejected evidence, stale hashes, account isolation, disabled access and zero-budget planner blocking. Full application tests, typecheck, lint and production build are run separately. Synthetic evidence does not demonstrate visual quality.

The integration is in the development branch. The table exists but app activation remains disabled by default. No precampaign render, paid generation, production deployment or approved-master replacement was performed. Release requires deploying the branch and configuring the owner feature flag; visual production still requires actual materials and reviews.
