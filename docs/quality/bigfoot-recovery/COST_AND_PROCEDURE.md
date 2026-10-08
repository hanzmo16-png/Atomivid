# Bigfoot (job 03738404): bounded repair, cost and recovery procedure

Status: **NOT RECOVERED.** Code and tests only; spend in this phase USD 0.00, no production writes, no merge, no deploy.

## What the offline replay proved (run 37766720148, no provider, no writes)

| Step | Result |
|---|---|
| 5 saved paid responses (research, 3 writer fragments, editorial review) | reused 5/5 in both runs; their request fingerprints match the current code |
| Bounded repair of `sections[2].function` | entered once; **SIMULATED** adapter label (`consequence`), not a real classification |
| Repaired review | passed schema, catalog references and editorial validation; 2 findings, **1 blocker** |
| Resume (second run) | repair reused (`repairReused: 1`, still 1 repair call) |
| First uncached call | correction writer at "Afinando la historia" (`max_tokens` 16000, reservation USD 0.2696); the replay stopped there |
| Production | checkpoint hash unchanged, job still `failed` / "Revisando el guion", 0 writes, 0 paid calls |

The real repair label belongs to the model and can change the outcome: `restatement` would add a blocker.
Since there is already 1 blocker, a correction round is certain either way.

## Reservations measured from the real request sizes (pricing in code: USD 2 / 1M input tokens, USD 10 / 1M output tokens)

`anthropicReservation = (bytes(params) + 8192) × input rate + max_tokens × output rate`. This is a conservative upper bound per call, reserved before the call and settled to the actual cost after it.

| Call | max_tokens | Reservation (USD) | Actual cost observed for this job (USD) |
|---|---|---|---|
| Editorial review | 6000 | 0.1704 | 0.0625 (pass 0) |
| Writer fragment | 16000 | 0.218–0.270 | 0.146 / 0.065 / 0.059 |
| Section-function repair | 600 | 0.038 | not yet (simulated) |
| Visual plan, one per block (V6 contract) | 4000 | about 0.084 (estimated from sizes: sources 3.7 KB, block ≤ 1.3 KB, V6 system 6.7 KB) | not yet |
| Reference repair (catalog-v1, at most 1 per run) | 1500 | about 0.09 (estimated) | not needed in pass 0 |

## Remaining calls to reach "Guion listo" and the cost cap

Structural limits in the code:
- 2 editorial passes, plus owner-granted extra rounds (`MAX_EDITORIAL_ROUNDS` = 2).
- A writer draft is at most 1 + `MAX_CONTINUATIONS` (3) calls.
- At most one function repair per saved review response (deterministic ledger key).
- At most one reference repair per run.
- Exactly 5 visual-plan calls.
- One new paid call per worker invocation.

| Item | Expected (USD) | Maximum reservation (USD) |
|---|---|---|
| Function repair, pass 0 | about 0.01 | 0.04 |
| Correction (writer: 1 call, up to 4) | 0.15–0.27 | 1.20 (0.27 + 3 × 0.31) |
| Editorial review, pass 1 | about 0.07 | 0.19 |
| Function repair, pass 1 (only if the label violation recurs) | 0 | 0.04 |
| Reference repair (only if references fail) | 0 | 0.09 |
| Visual planning, 5 blocks | about 0.12 | 0.50 |
| **Total to "Guion listo" (2 passes)** | **about 0.35–0.55** | **2.06** |
| Each extra editorial round (owner decision; maximum 2) | about 0.25 | 1.52 (correction 1.20 + review 0.19 + repairs 0.13) |
| **Absolute maximum, with 2 extra rounds** | | **5.10** |

If pass 1 still has blockers, the job stops as an **editorial** failure, not "Guion listo". Visual planning is not spent in that case.

Proposed ceiling: **USD 2.10** of NEW spend for this recovery, now **enforced by the database** (next section).
Each extra editorial round (USD 1.52 maximum) needs a separate decision. The cap is never raised automatically.

## Hard cap (migration `20261008120000_documentary_recovery_budget.sql`, prepared, NOT applied)

**Mechanism.**
- `pi_recovery_budgets` holds one row per job.
  - Key: the job's ledger `project_id`.
  - Bound to `job_id` and `owner_id`; the `project_id` must be `documentary:<owner>:…`.
  - Stores `cap_usd` (`numeric`), the `baseline_keys`, and an authorization reference.
- The row is immutable: a trigger forbids changing the cap or baseline, deleting the row, or reopening a closed one.
- `pi_open_recovery_budget` is idempotent.
  - Opening again returns the existing budget unchanged: no reset, no raise.
  - It refuses a job that is not `failed`, a project of another owner, or a project with uncertain operations.
- The original `pi_submit_with_supply` is kept **byte-identical** as `pi_submit_with_supply_core`. A new `pi_submit_with_supply` with the same name and signature runs first and works in three steps:
  1. It locks the budget row (`FOR UPDATE`).
  2. It re-reads the operation and computes the spend in exact `numeric`.
  3. It admits the call only if `committed + pending/uncertain + this reservation ≤ cap`; otherwise it refuses **before** the provider and the operation stays `RESERVED`.
  4. If admitted, it delegates to the unchanged core, so all existing supply/cap/concurrency/reconciliation checks still apply.
- Projects without a budget behave exactly as before.
- The application role can no longer call the core directly. Opening a budget is not granted to the application; it is an operator action.

**What counts against the USD 2.10.** All ledger operations of the job's project **except** the baseline (the five already-paid responses, frozen when the budget is opened):

| Ledger status | Counted as |
|---|---|
| `COMMITTED` | its committed (actual) cost |
| `SUBMITTED`, `PROVIDER_JOB_RECORDED`, `RECONCILIATION_REQUIRED` | its full reservation (uncertain spend is never released without reconciliation evidence) |
| `REFUNDED` | 0 |
| `RESERVED` (not admitted) | 0. It can reach the provider only through this same locked check |

- Reusing a COMMITTED response never calls the check again, so it never reserves or charges twice.
- This covers every pending step: function repair, writer correction, editorial review(s), reference repair and visual planning. They all share the job's project.

**Atomicity.** Two workers serialize on the budget row lock. Two reservations that each fit but together exceed the cap cannot both be admitted. This was verified with two real Postgres sessions: 0.60 + 0.60 under a 1.00 cap, and the second worker waited for the first one's lock and was refused. Removing the lock makes the same test fail, so the test detects it.

**Precision.**
- Exact `numeric` in the database. 0.7 + 0.7 + 0.7 = 2.10 is admitted, where a JS double gives 2.0999999999999996; 0.0001 more is refused.
- The ledger column keeps 4 decimals, so the application now rounds reservations and committed costs **up** to 0.0001 before storing them (`ceilLedgerUsd`). A stored amount is never below the computed one.
- The ledger key does not include the amount, so the five paid fingerprints are unaffected.

**Budget projection (worst case, one call at a time).**

| Step | Max reservation | Cumulative |
|---|---|---|
| Repair | 0.038 | 0.038 |
| Correction (up to 4 writer calls) | ≤ 1.20 | 1.238 |
| Review, pass 1 | 0.19 | 1.428 |
| Repair, pass 1 | 0.04 | 1.468 |
| Reference repair | 0.09 | 1.558 |
| 5 visual plans | 0.50 | 2.058 |

All steps fit under 2.10 even in the worst case. Expected actual spend is about 0.35–0.55.

## Procedure after deploy and spend are approved (nothing here has been executed)

1. Review and merge PR #61.
2. **Apply the migration** `20261008120000_documentary_recovery_budget.sql` in Supabase. Do this before or with the deploy; the code works with or without it.
   - Verify: `pi_submit_with_supply_core` exists, and `service_role` can execute `pi_submit_with_supply` but not the core.
3. Deploy, then confirm the production deploy SHA.
4. Run the read-only diagnostic. Check:
   - the job is still `failed` / `technical`, with `retry_count` 0;
   - there are 5 COMMITTED ledger operations;
   - there are no uncertain operations;
   - the `projectHash` printed by the replay.
5. **Open the budget once** in the Supabase SQL editor, as the owner (not the application role):

   ```sql
   select public.pi_open_recovery_budget(
     '03738404-02ce-440a-a588-cb51ae4a0e9f',
     (select project_id from public.pi_paid_operations
       where left(encode(sha256(convert_to(project_id,'UTF8')),'hex'),10) = '<projectHash>' limit 1),
     2.10, '<authorization reference>');
   ```

   Expect `opened: true` and `baselineOperations: 5`. `pi_recovery_budget_usage(project_id)` must show remaining 2.10.
6. The owner presses **Reintentar** once.
   - Fenced on `updated_at` and on the worker `run_token`.
   - The same ledger project is reused, so the 5 responses replay for free.
7. Each worker invocation makes at most one new call. The database refuses any call that would exceed 2.10, before the provider.
   - On refusal the job fails with "Se alcanzó el presupuesto autorizado…". Never raise the cap without a new authorization.
   - On any uncertain operation, stop and reconcile; never resubmit.
8. "Guion listo" requires editorial approval under the normal rules.
   - If pass 1 is blocked, the job ends as an editorial failure; extra rounds are a new decision.
   - Close the budget afterwards: `update pi_recovery_budgets set status='CLOSED', closed_at=now() where project_id=…`.

## Verification of the hard cap (local Postgres 16, no Supabase, no provider)

How to reproduce:
- Load the stub schema and the Supabase roles (`anon`, `authenticated`, `service_role`).
- Apply all repository migrations, plus `0023`–`0025` (`pi_paid_operations` and the supply tables). These come from commit `9dccd68`; they are applied in production but are not in this branch's tree.
- Then run:
  - `verify/documentary_recovery_budget.sql` inside `BEGIN … ROLLBACK`;
  - `verify/documentary_recovery_budget_concurrency.sh` (two real sessions).

| Check | Result |
|---|---|
| `documentary_recovery_budget.sql` | PASS. Baseline excluded; 2.10 admitted at the limit; +0.0001 refused before the provider (row stays RESERVED); committed, pending and uncertain spend counted; COMMITTED reuse not double counted; immutable across a job retry; closed budget stops; unbudgeted project unchanged; the application role cannot call the core or open a budget |
| Concurrency (2 sessions, 0.60 + 0.60, cap 1.00) | PASS. The second session waited for the lock (about 1.5 s) and was refused; one admission |
| Negative control (same migration without `FOR UPDATE`) | FAIL, as expected: both admitted. The test detects the missing lock |
| Re-applying the migration | idempotent |
| Existing supply checks, before and after the migration | identical. `provider_supply_calls` and `provider_supply_twenty_dollar_cap` PASS on both. The other four fail identically on both, from fixture problems in the local harness (missing auth user, balance) |

## Audio loudness test (`src/lib/video/audio-master.test.ts`): base vs PR

- Same machine and same `node_modules`, one run at a time, alternating base (`ff095b6`, a worktree of `claude/atomivid-mvp-setup-0079jv`) and PR, 30 runs each.
- `audio-master.ts` and its test are byte-identical between base and PR, and import only `node:child_process`. No PR code reaches them.

| Branch | Failing runs | Failure |
|---|---|---|
| base `ff095b6` | **4 / 30** | the same test ("masterización con margen…"), lines 116–117 |
| PR | **5 / 30** | the same test; e.g. `sonoridad -18.07 / -18.18 LUFS` (±2 tolerance), `con margen: -1.45 dBTP` |

- The test is intermittent **on the base branch too**, at an indistinguishable rate.
- It depends on the ffmpeg AAC encode and measurement, not on this change.
- No audio code is modified here; fixing it is a separate task.

## Execution 2026-10-08 (owner-authorized)

| Step | Evidence |
|---|---|
| Migration `20261008120000` applied (only that file) | ops `verify-rpc`: `pi_submit_with_supply_core` present. `service_role` can execute the wrapper but not the core nor the opener; `anon`/`authenticated` none. Registered. Functional refusal inside a rolled-back transaction: "recovery budget exceeded", op stays RESERVED, cap raise blocked |
| PR #61 merged; production `f6f93ee` | Vercel Production deployment success |
| Job and project verified | real `project_id` recomputed (hash `012ff073f3`); 5 COMMITTED, 0 uncertain; owner confirmed |
| Budget opened once | cap 2.10, ACTIVE, baseline = exactly the 5 COMMITTED operations |
| Recovery 1 | real repair 0.0059, correction 0.1195, continuation 0.0735. Then `2c686020`: the plan fragment was refused only on `creativeDirection.weakness` (307–312 > 300 chars) |
| PR #62 (accept explanatory metadata up to 1600, request unchanged), production `e57266a` | offline replay against the saved responses: completes the correction and stops at review pass 1 |
| Recovery 2 | review pass 1 0.0501; repair 0.0058 (the review again had an out-of-contract function). Then `a1a4453c`: `validateEditorialReview` refused the review: "La primera recompensa marcada aparece después de la apertura" (the reviewer marked the first answer delivered, with evidence after the first 150 words) |
| Stop | editorial-validation rejection on the last pass, deterministic on replay. No approval forced, no extra rounds; the remaining retry was not used |
| New spend | **USD 0.2548 of 2.10** (5 new COMMITTED operations, 0 uncertain); 10 COMMITTED in total, the original 5 reused |
| Budget | closed after the recovery (one-way); committed results stay reusable |


## Authorized continuation (2026-10-08 08:13 Cancun)
The critic cited words 145–156 but justified its decision by the first block (207 words). The existing 150-word gate remains unchanged. A new bounded, deterministic `opening-payoff-evidence-repair-v1` call rechecks only `firstAnswer` against complete catalog excerpts ending by word 150. No eligible reward produces an editorial blocker, not approval. Other judgments and findings remain unchanged; reservations and cached responses use the existing ledger.

`20261008131541_documentary_recovery_resume.sql` adds operator-only, single-use authorization to resume the SAME budget after it was closed prematurely. Original cap USD2.10, baseline five, and all accumulated spend remain immutable. The application cannot call the resume function. `resume-budget` records the owner's new explicit authorization; it does not reset spend. Keep the budget active while resolving a failure; close only after completion or intentional cancellation.

Validation: 108 editorial tests, 97 spend tests, typecheck and lint; PostgreSQL WASM verification covers preserved spend/baseline/cap, unauthorized reopening, idempotency, uncertain-operation refusal and the exact cap boundary. Reproduce via `scripts/verify-recovery-resume.mjs` with a separately installed `@electric-sql/pglite` and PGLITE_MODULE pointing to its module.
