# Runbook: avatar creations with an uncertain outcome (T46 D3)

Applies when `createAvatarOnce` returned `uncertain`, `stale` or `not_recorded`, or when the paid-call ledger has an `avatar:create` operation that is not settled.

## Invariant
- Nothing is resubmitted automatically: not because of a TTL, a retry, or a page reload.
- The reservation (the `avatar-uploads/<user>/<requestId>.<ext>` object plus the ledger row) is kept until there is **conclusive** evidence.
- The 10-minute `stale` mark is not proof of failure. It only changes the message shown to the customer.

## States
| State | Source | Allowed action |
|---|---|---|
| `in_flight` | ledger `SUBMITTED`, recent | wait; never call |
| `uncertain` | ledger `SUBMITTED` → `RECONCILIATION_REQUIRED`, or provider timeout/5xx/4xx/invalid response | manual review |
| `confirmed_success` | evidence that the asset exists at the provider | record the avatar row with that asset id; settle the ledger as COMMITTED with the asset as `resultRef` |
| `confirmed_final_reject` | provider response proving nothing was created, or a local refusal before the network (no key, consent, budget, moderation) | settle as REFUNDED; release the photo |
| `needs_manual_review` | evidence missing or the query failed | stay blocked; the customer sees the «uncertain» message |

## Procedure (operator, read-only on production until the decision)
1. **Find the unsettled operations:** rows in `pi_paid_operations` with `method = 'create_avatar'` and status `SUBMITTED` or `RECONCILIATION_REQUIRED`. Their `project_id` is the request id.
2. **Check the matching objects** under `avatar-uploads/<user>/<requestId>.*`, and whether an `avatars` row has that `source_photo_path`.
3. **Check the provider** (HeyGen dashboard or asset listing). Only if that is free and authorized: look for an asset created at the operation's time. Without conclusive evidence, stop: the state is `needs_manual_review`.
4. **Write a decision record**, approved by the owner, before running any settlement. It must contain: operation key, evidence, decision, operator.
5. **Settle with a compare-and-set** against the observed status (as `commitRecordedPaidJob` does), never with a blind overwrite. Then:
   - for `confirmed_success`, insert the `avatars` row;
   - for `confirmed_final_reject`, remove the claim object.
6. **Never** call `createAvatar` again for the same request id. A new avatar requires a new intent (another photo, or an explicit «crear otro video igual»).

## Not implemented (pending)
- An automatic status query to HeyGen (it may be paid or unavailable; mocks only).
- An admin screen or script for steps 1–5.
- Logs and reports must not include photos, private URLs or keys.
