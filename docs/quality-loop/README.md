# Autonomous Quality Loop 1.0 — issue #320

This extends Mystery Shopper; it does not replace the engine, create a financial ledger or call a paid provider.

## Components and boundaries

- `.github/workflows/mystery-shopper.yml`: every 30 minutes at :23/:53, successful production deployment events, and explicit `quality-loop` dispatch. Standard Linux public-repository runners only; the public-repository condition is checked before allocating the periodic job. GitHub scheduling is best effort, not a 24/7 uptime guarantee.
- `scripts/mystery-shopper/quality-loop/browser.ts` reuses the existing authenticated surface inspector, `findingsFrom`, auth classifier and anonymous smoke. A fresh QA browser runs mobile and desktop. Only login POST is allowed; application APIs default-deny, third-party providers and streaming are blocked. No production Storage job creation, service-role secret, reservations, ledger resets, generations, retries, subscription changes or checkout charges.
- A build identity endpoint returns only `VERCEL_GIT_COMMIT_SHA`. SHA is read before and after the traversal; unavailable/changing SHA cannot revalidate defects. Runner SHA is separate.
- Existing Sentinel #338 endpoint is read, not rebuilt. Account/worker/financial unknowns remain BLOCKED. No balances or authenticated content enter public reports. #337 UI and #338 supply files remain untouched.
- Existing media: periodic/deployment production payload downloads are BLOCKED while free egress quota is unverified. Explicit manual QA or local fixtures can read at most one 256 KiB sample per product/cycle. Playable samples and successful bounded GET are measured, full-file integrity/content/lip sync remain unaccredited. This avoids unlimited repeated downloads. Registration confirmation, persisted configuration, job recovery, logout and checkout are tested in isolated fixtures, never silently presented as production PASS.
- `model.ts`: stable product/check fingerprint, CAS claim, lease expiry/fencing, module conflict prevention, exact-SHA revalidation and recurrence reopening. A branch runner cannot close a real defect: the evaluator source SHA must equal the deployed application SHA. BLOCKED/SKIP/fixtures do not close real defects. A stopped queue fences in-flight publication.
- The state branch carries a branch-specific `vercel.json` deployment exclusion; the application config also excludes that exact branch. Queue updates must not start Vercel builds.
- State is `state.json` on an orphan `automation/quality-loop-state` branch; never the production/source branch. Writes use the GitHub content SHA as compare-and-swap. An unreadable/corrupt state is not an empty healthy queue. Reports/history are bounded; defects are preserved and overflow stops writes rather than silently losing work.
- Drive reuses `DriveRestChannel` and OIDC, default branch + protected `orchestrator` environment. Every snapshot/task is append-only and read back. Three task publications maximum/cycle, stable task IDs, prior ACK check, no repeated assignment. Publishing does **not** activate an agent.
- Command Center `/dashboard/command-center/quality-loop` and API use the existing OWNER/ADMIN confirmed-account gate. Controls are same-origin admin POSTs. After a reload, only the same authenticated claim actor can recover its own live fencing token; reads do not renew the lease, and another administrator cannot submit that actor's transitions. Integration records require the SHA of the deployed application. No secrets or migrations were added.

## Activation and stop

The executive order of 26 November activates the free periodic mode in the workflow (`MYSTERY_SHOPPER_AUTO` defaults to `1`). An existing repository variable set to `0` still prevents it. The queue's admin emergency stop also prevents claims and fences an ongoing worker between product reads. Restart does not discard defects or the ledger. A lost worker's lease expires after 20 minutes; the next run can recover. Repeated events with the same run/deployment ID do not repeat completed cycles.

The schedule exists only after this workflow reaches the default branch. A branch/manual/fixture run is not cron evidence. Automatic production deployment of a new PR is not authorized merely by this document: follow the applicable merge/deploy gate.

The application uses the existing `GH_WORKER_TOKEN` for queue controls. If that binding lacks content-write permission, controls show a real failure; no permission or secret is silently changed. QA bindings are the existing `Preview` environment's email/password. A non-admin QA account can traverse products but Sentinel correctly returns 403 and stays BLOCKED. Do not grant admin privileges to make tests green.

## Correction execution and honest limits

Tasks are persisted, assigned and atomically claimable; Codex/Claude sessions consume them. This implementation does not impersonate a running external session. The repository's existing `claude-executor.yml` is review/result-only (its prompt forbids edits outside result.md); it is **not** a code-fix executor. Enabling it would not provide the requested implementation loop. No paid API or unverified subscription capacity is activated as a substitute. Until a capable, authenticated, zero-additional-cost executor acknowledges a task and its correction is integrated with applicable authorization, the system is surveillance + persistent handoff, **not certified autonomous correction 24/7**.

## Verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm install --no-save --ignore-scripts --no-audit --no-fund playwright@1.49.1
npx playwright install --with-deps chromium
node --import tsx --test src/lib/mystery-shopper/quality-loop/*.test.ts
node --import tsx --test scripts/mystery-shopper/quality-loop/*.test.ts
node --import tsx --test src/lib/billing/checkout.test.ts src/lib/billing/checkout-error.test.ts src/lib/auth/recovery.test.ts src/lib/auth/recovery-flow.test.ts src/lib/mystery-shopper/v3/start-response.test.ts
npx next typegen
npx tsc --noEmit
```

Browser fixtures use a real local HTTP server and Chromium, with an intentionally missing Reel control before the corrected fixture. They also exercise the actual React panel, claim and stop/restart. The initial controlled request-guard mutation and its red test are preserved separately; no real product defect or production execution is fabricated from it.

## Acceptance gates (evidence required, not assumed)

Two consecutive schedule-triggered run URLs, real QA auth, four-product observations, deployed Sentinel read, controlled defect + genuine claim + correction + same-SHA revalidation, alerts, Drive readback, admin controls, zero paid calls, restoration. Any missing gate remains BLOCKED/NOT DEMONSTRATED. The issue remains #320, no duplicate campaign issue.

## Rollback

Stop through the admin API/panel (or set the existing repo variable to `0`); disable the scheduled job if necessary. Preserve the state branch and Drive evidence. Revert this code PR to restore the previous UI/workflow. No product data, reservations or budgets require rollback. Do not delete the queue or financial ledger.

## First authentic branch run and correction

Manual run `45886485209` (not cron) confirmed QA authentication, with50PASS/2FAIL/22BLOCKED/12SKIP. Both FAIL were the same stale test selector: `modalidad-video` does not exist in the production wizard's `visual/avatar/dialogo` contract. The inspector was corrected, with a browser regression covering all three actual choices, and the two viewport findings were consolidated/claimed in the persistent queue by the active Codex session. The original run and state remain preserved. A subsequent PASS must not be called production integration while this PR is only a branch. Build identity and Resource Sentinel were unavailable in that production version; those blockers were retained.

## Schedule registration experiment — 2026-11-27

The workflow is active on the default branch, the application queue is enabled with no live lease, and Actions had only one authentic schedule event (45938752780). No code/configuration root cause was established. Retiming the same half-hour cadence from :17/:47 to :23/:53 re-registers its cron without increasing executions, adding a scheduler or enabling the native corrector. This is an operational experiment, not evidence of a fix. Manual/deployment events never qualify as schedule evidence.

Acceptance requires two consecutive new `event=schedule` runs after this change reaches the default branch, each pinned to the deployed source and retaining all FAIL/BLOCKED. Until then scheduling remains NOT ACCREDITED. If no event arrives, preserve API evidence and escalate to GitHub Actions support; do not repeatedly change cron or invent a successful heartbeat. Rollback restores the previous cron and nominal-time calculation together; it does not erase the queue, ledger or evidence.

## Audited GET inspection and legacy-backend gate

GET alone is not a no-write guarantee: dashboard/history previously reconciled stale jobs and closed stale attempts. The explicit `inspection=read-only` mode skips only those maintenance callbacks; normal recovery, authentication and ownership are unchanged. The observer checks build-info capability before login and uses the existing safe `redirectedFrom` form contract so the Server Action's internal redirect also carries the mode. Same-origin audited GET/RSC navigation preserves that flag. A backend without the capability is BLOCKED before traversal, not treated as safe because a client blocks POST.

Controlled Chromium and maintenance-callback tests verify this behavior, not genuine production authentication. The mode does not certify atomic routing across a mid-run rollback or zero internal provider HTTP (some server components list voices with official GETs). Storage metadata reads remain bounded and full-media/egress evidence remains blocked until separately verified. The native code corrector stays HOLD; this interactive correction does not activate or replace it.
