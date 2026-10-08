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

Proposed ceiling for the authorization: **USD 2.10** for recovery up to "Guion listo" with the existing passes.
Each extra editorial round (USD 1.52 maximum) needs a separate decision.
The ceiling can be checked by summing `committed_usd` (and open reservations) in `pi_paid_operations` for this job's `project_id`. The read-only diagnostic already prints them.
The existing per-provider daily and monthly caps (`pi_supply_policies`) still apply.

## Procedure after deploy and spend are approved

1. Merge PR #61 and deploy. Confirm the production deploy SHA.
2. Run the read-only diagnostic. Confirm the job is still `failed` / `technical` with `retry_count` 0, and the ledger still holds 5 COMMITTED entries.
3. The owner presses **Reintentar** once.
   - `retryScriptJob` is fenced on `updated_at` (double clicks are ignored).
   - The worker claim uses `run_token` (job ownership).
   - The retry does not change the ledger scope, so the 5 responses are reused.
4. Each worker invocation makes at most one new call: the repair, then the correction fragments, then review pass 1, then the 5 visual plans. Everything else replays from the ledger.
5. After each invocation, check the ledger total against the USD 2.10 ceiling with the read-only diagnostic.
   - Stop (do not press Reintentar) if a reservation would exceed it.
   - Stop if any operation is `SUBMITTED` or `RECONCILIATION_REQUIRED`. Never resubmit; reconcile first.
6. "Guion listo" requires editorial approval by the normal rules. A repaired label never approves anything.
   - If pass 1 is blocked, the job ends as an editorial failure. More rounds are a new owner decision.
