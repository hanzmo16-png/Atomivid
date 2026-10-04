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

Direction → styleframe (the frozen frame law) → motion → integration → review master. Every final-stage task requires all prior-stage approvals. Delivery additionally requires master approval. Approvals bind the current plan hash and artifact SHA-256 and are recorded against the authenticated owner. For an environment sequence, each world has a separate scope hash containing its source, material SHA-256, light, frame interval, tasks, shared contract and transitive dependencies. A local correction clears only that world and dependent results; unrelated worlds retain their outputs and approvals. Shared contract corrections invalidate every affected scope. A single-world legacy plan change clears all results. Replacing an unchanged plan is a no-op. Rejected or stale reviews block advancement. Stage capabilities are registered by the host, not supplied by Claude.

Subjective reviews are explicitly human evidence, not automated claims of cinematic quality. Centered composition is not inherently defective. All failing findings block approval, even if an iteration prioritizes only three repair notes.

A RUNNING task after process death is not retried blindly. `reconcileTask()` can recover a measured existing output through an executor recovery port, after the old runner has terminated; otherwise it stays reconciliation-required. A normal caught task failure resumes that task without rerunning the planner or completed tasks. Paid generation executors remain blocked until individually integrated through existing gates.

## Runtime configuration

Use existing Supabase credentials and `AVATAR_PREPARATION_OWNER_EMAIL`. Preview enables only the configured verified owner by default; `VFX_DIRECTOR_ENABLED=0` disables it explicitly. Production remains disabled unless `VFX_DIRECTOR_ENABLED=1`. The manifest is trusted runner configuration and contains owner UUID, job ID, brief, approved plan, asset identities and registered executors. It must never come directly from model or browser input.

`VFX_JOB_MANIFEST=/trusted/manifest.json VFX_WORKER_ACTION=init|plan|inspect|step|reconcile npm run vfx:worker`

For live planning only: existing `ANTHROPIC_API_KEY`, `ANTHROPIC_SCRIPT_MODEL`; operator-verified `VFX_PLANNING_PRICE_SOURCE`, `VFX_PLANNING_INPUT_USD_PER_MILLION`, `VFX_PLANNING_OUTPUT_USD_PER_MILLION`, `VFX_PLANNING_MAX_USD`. Missing/unverified pricing or insufficient budget blocks. No live planning call was made in this implementation session.

Migration `20261003141710_vfx_director_jobs.sql` applied to the Atomivid project. Verified real database revision CAS rejects stale updates and client roles lack table privileges; probe transaction rolled back. RLS without client policies is intentional for this service-only table.

## Precampaign direction — no render yet

Preserve the approved UI navigation, voice, music, captions and closing. Inspect the 1080p master to distinguish proxy compression from actual background/crop degradation. Opening concept: apartment → Times Square → beach → moon → existing UI. Do not extend the original recorded take or loop it to satisfy an invented duration.

Before rendering: measure the actual source duration/framing; assign three exact frame windows within that slot; obtain moving plates with matching framing, crop density and perspective; freeze each environment's styleframe and light treatment; approve low-resolution motion and integration. The lunar scene deliberately suspends ordinary realism and must state its world rules.

The brief must declare every requested world. The plan must contain exactly one direction, frozen-look, motion and integration task per world, consuming the prior proof; the master must consume every integrated world. `compilePlan` rejects an omitted world, unsupported light treatment or unsupported frame interval BEFORE claiming a worker task. Worker checks the entire plan against its real registered capabilities on every invocation. Review API and worker inspection expose `reviewScopes` with the exact hashes to review.

The VFX-002b adapter currently supports one plate and a fixed nighttime treatment, not a proven three-environment recipe. The director must return NEEDS_MATERIAL or reject that route until sequence-aware plate composition and environment-specific light treatments are registered. This is an explicit capability boundary, not permission to silently deliver NYC alone.

## Validation and release status

Director/worker failure tests include concurrent execution, unchanged plan on resumption, rejected evidence, stale hashes, account isolation, disabled access and zero-budget planner blocking. Full application tests, typecheck, lint and production build are run separately. Synthetic evidence does not demonstrate visual quality.

The integration is in the development branch. The table exists but production activation remains disabled by default. No precampaign render, paid generation, production deployment or approved-master replacement was performed. Release requires deploying the branch and configuring the owner feature flag; visual production still requires actual materials and reviews.

## Environment hardening, 2026-10-03

Executable capability metadata now declares city/night-practical/full-shot-only for VFX-002b. Its runtime independently refuses beach, Moon, missing environment contracts and changed plate bytes before reading source or invoking Python. The full-source crop and duration requirements remain. A sequence-aware compositor is still required to produce the three-world opening. This change closes the scheduling hole; it does not claim that a missing production adapter has been implemented.

Real Anthropic responses must carry nonzero, valid token usage; actual usage is costed and committed through the paid-call ledger. Fixtures use a separate injected test transport and do not represent paid provider calls. No live Claude call or new video render occurred during this hardening.

Validation of this revision: 27 director tests, 1,552 application tests, typecheck, lint and production build passed locally. CI generates Next route types before typecheck; the clean runner also passed the director suite. The campaign audit reads persisted media and exports original-resolution control frames without a provider call, storage mutation or replacement master.

The read-only CI audit recovered the original 1080×1920 source, composite and master control frames. The source slot is exactly 150 frames/5 seconds; the existing master is 35.233333 seconds. Visual inspection confirms softened background detail in the full-resolution master, not just a low-resolution proxy. The legacy compositor applies Gaussian sigma 1.6 and synthetic plate noise sigma 0.010. Its next-render recipe reduces blur to sigma 0.45 and removes synthetic noise; capability recipe version `vfx002b/clarity-2` changes the plan fingerprint so prior approvals cannot authorize the changed recipe. This is a code correction, not a claim that a corrected video has been rendered or visually approved. Audit run: https://github.com/hanzmo16-png/Atomivid/actions/runs/37132248576 (core and media audit passed).

## Page-initiated durable execution, 2026-10-04

The `/dashboard/vfx` page can now ask the protected worker to run **one** durable task (or reconcile an interrupted one). Design:

- **Browser vocabulary:** `{action:"execute", id, mode:"step"|"reconcile", revision, planHash}` and `{action:"resolve-dispatch", id, key}`. The schemas are strict, so executors, paths, prices, manifests, refs and commits are rejected (tested).
- **Server configuration:**
  - Executors, materials and capabilities come only from `execution-profiles.ts` at the deployed commit.
  - The precampaign job's profile is the zero-cost `artifact-registry` with the frozen capability `artifact-registry/approved-styleframes-1`. Any difference makes the runner refuse before touching the job.
  - Compositor profiles (`world-composite`, `cut-master`) bind private Storage objects by SHA-256. They are materialized into a fixed runner directory, so recipe fingerprints are stable.
- **Gates:**
  - Owner session (`directorActor`), same-origin POST.
  - Execution is on by default only on preview (`VFX_EXECUTION_ENABLED`). Production also needs `VFX_EXECUTION_PRODUCTION=1`.
  - It requires `GH_WORKER_TOKEN`/`GH_WORKER_REPO` and the deployment's `VERCEL_GIT_COMMIT_REF`/`SHA`.
- **Ledger first:**
  - A USD 0 `pi_paid_operations` row (`method=vfx_execution_dispatch`) is inserted before the GitHub call.
  - Statuses: `RESERVED → SUBMITTED` (accepted), `REFUNDED` (4xx, nothing ran) or `RECONCILIATION_REQUIRED` (timeout/5xx, outcome unknown).
  - The key `vfx_exec:<job>:r<revision>:n<sequence>` makes concurrent clicks collide on the unique key. Any non-final row blocks new dispatches for that job.
- **No automatic repetition:**
  - Uncertain or interrupted dispatches stay blocking until the owner presses "Cerrar ejecución interrumpida".
  - That action is allowed only after the queue/runner grace period, and only when the GitHub runs API shows no queued or running run carrying the key. The run title includes the key.
  - Closing never dispatches. Reconciling a `RUNNING` task needs a new explicit request, and is accepted only when no dispatch is active.
- **Runner** (`precampaign-teaser-v1.yml`, stage `vfx-director-execute`; that file is already registered on the default branch, so nothing is merged there):
  - The run claims `SUBMITTED → PROVIDER_JOB_RECORDED` exactly once. A different commit or ref, or a forged key, is refused.
  - It verifies the owner, revision and plan hash, profile/inventory equality, review gates, dependencies and staged-material fingerprints before calling `runTask`. A failing check is recorded as `blocked_before_task` and the job is left untouched.
  - It records the outcome as `COMMITTED`.
  - `VFX_WORKER_ACTION`/manifest operation (`director-worker.ts`) is unchanged for operators.
  - `vfx-director-inspect` is a read-only diagnostic.
- **UI:**
  - Translated job and dispatch states; readable project, world, stage and criterion names.
  - Hashes, keys and codes are kept in "Detalles de auditoría".
  - The layout is checked at 320/390 px on `/dev/vfx-director` (dev only) with every details panel open: scrollWidth equals the viewport and no element extends past it.

Verified job state (read-only CI inspection, run 37173117238, commit 84381f1):

| Field | Value |
|---|---|
| Revision | 53 |
| Status | `REVIEW_REQUIRED` |
| Tasks with a measured result | 13 of 13 |
| Approvals | 18 |
| Active task | none |
| Dispatch rows | none |
| Frozen inventory | `artifact-registry/approved-styleframes-1`, exactly equal to the server profile |

Consequences:
- The page shows "No quedan tareas por ejecutar" with the button disabled.
- The API refuses an execute request (`VFX_NOTHING_TO_EXECUTE`) before writing anything.
- The approved video cannot be regenerated or replaced from the page, and execution never creates or changes approvals.
- The first real page execution will happen when a correction leaves a task without a result. A staged artifact for it must exist at `<job>/execution/staged/<task>.json` (written by a trusted operator script) for the registry to record it.

### Release blockers (2026-10-04)

1. **Preview deployment.** Run 37173181725 of `owner-pilot-preview.yml` stopped at its first check: the repository secret `VERCEL_TOKEN` is empty (`PREVIEW_DEPLOY_BLOCKED_PRIVATE_STATE_RETAINED`; no ledger row written). Git deployments are disabled for this branch in `vercel.json`. The READY preview `atomivid-liylclzem` therefore still runs the previous commit, without the execution panel. To publish commit `3e0e4c7` or later as preview, either add `VERCEL_TOKEN` and push a change to `scripts/deploy-owner-pilot-preview.ts`, or deploy that commit manually as **Preview**, never Production.
2. **Worker credential on preview.** The page needs `GH_WORKER_TOKEN` and `GH_WORKER_REPO` on the preview target. The token needs "Actions: read and write" on this repository: write to dispatch, read to confirm runs before resolution. Their presence on preview could not be checked, because the env-name report runs after the token check. When either is missing, the page shows "Falta la credencial del worker de GitHub en este entorno" and nothing is dispatched.
3. **Owner click.** Executing from the page requires the owner's authenticated session. This was not performed by the agent.
4. **Nothing pending.** Every task of the current job has a result, so even with 1–3 resolved the button stays disabled until a correction leaves a task pending.

Verified without the page: strict request schema, ledger-first dispatch, concurrency, uncertain dispatch handling, resolution, claim-once, commit pinning, profile/inventory equality and untouched-job checks (16 tests). The real runner ran read-only against the production job in CI. Typecheck, lint and build pass. All 1,596 application tests pass.


## Isolated real compositor trial (2026-10-04 UTC)

The owner completed the web orchestration probe: dispatch `vfx_exec:vfx-execution-smoke-v1:r0:n1`, GitHub run 37175892313 SUCCESS, one COMMITTED USD 0 row, private bytes measured, job revision 2. This was not a render. The source precampaign remains revision 53 with 18 reviews.

`vfx-compositor-trial-v1` is a separate pending master task. Its reviewed server profile binds source revision 53 and native file SHA 58a6f6395dcb1d35301e69ed74c01d42b19de6b6081e34ad805bbf2aa010a51e. The executor reads the original job's live owner-scoped gates and bindings; it copies no approvals. All four prior stages of all three worlds must still pass. A rejection or source revision change blocks publishing.

The worker verifies the native file, decodes and verifies each reviewed RGB24 interval, extracts lossless FFV1 segments, invokes the real `cutMasterExecutor` to assemble hard cuts and one global grain pass, and verifies 150 frames / 1080x1920 / 30 fps. It persists MP4 bytes and a receipt in private Storage, downloads and verifies them before reporting success, and publishes a byte-bound private review binding. A fresh worker can recover the stored receipt without rendering. Source media, source reviews and the approved full campaign are untouched. No paid provider credentials are passed.

Local validation includes an actual small FFmpeg render, durable recovery in a fresh directory, corrupt persisted media rejection, owner/version gates and a beach rejection. The live page render and owner visual review are still pending; these tests do not establish cinematic quality or completion of the whole SaaS. A new Preview of this commit is required before its pending task can be dispatched from the owner session.


### Live trial gate correction (2026-10-04)

Dispatch run 37197132215 was blocked before touching the trial with `VFX_REVIEW_GATE_PENDING`, USD 0. The isolated task was incorrectly declared `master`: global master gates demand prior reviews of that job, which intentionally has none. It is now a `preview` proof task. The specialized trusted executor still validates all source-world master prerequisites, current source revision, exact native media and reviewed interval pixels before rendering; original final-stage gates are unchanged. No approvals are copied or invented, and a proof cannot be approved as a campaign master through the API.

The measured output has a byte-bound `preview` binding and a dedicated proof viewer. An integration regression now exercises `createJob` → `runTask` → real FFmpeg → private result → viewer binding, not just the executor in isolation. The preparation script can repair only the exact untouched revision-0 trial plan with no results, approvals or active dispatches; completed jobs are never reset. Source precampaign revision 53 is unchanged.
