# Durable spend authorization for Podcast Studio long scripts

**Status: DESIGN / review-only. Do not apply. Do not deploy. USD 0.**

Proposal: `supabase/proposals/20261101152000_studio_script_spend_authorization.sql`
Rollback: `supabase/proposals/20261101152000_studio_script_spend_authorization.rollback.sql`
Auditor context: ChatGPT AUDITADO-BLOQUEADO T-20261101-1520, production tip `4f88e640` (#268).

This file is the review guide. Applying the SQL is a later, separate decision. Nothing in this change calls a provider or pushes a schema.

## How to review without applying the migration

1. Read this document, then the proposal and its rollback. The proposal lives under `supabase/proposals/`, not `supabase/migrations/`, so the disposable migration harness and `apply-supabase-migration` do not pick it up.
2. Run the unit tests (no database): `node --import tsx --test src/lib/podcast/studio-script-authorization.test.ts src/lib/podcast/v3/long-script.test.ts`. They lock the reason strings to the SQL text and the flag-off path.
3. Optional, still USD 0, still not production: `bash scripts/qa/studio-script-auth-db.sh`. That command creates its own PostgreSQL cluster on a unix socket, applies the proposal to a database named `studio_script_auth`, and destroys the cluster. It refuses any other database name and any non-local host. CI workflow `studio-script-auth-postgres` does the same. It does not run `supabase db push`.
4. A schema-history scan that looks for `CREATE FUNCTION pi_submit_with_supply` will report this file as **PARTIAL** against production, because the proposal replaces that existing entry point while the new tables are absent. That PARTIAL line means "not applied", not "half-applied in production".

`PODCAST_STUDIO_SCRIPT_DURABLE_AUTH` is unset in this PR. With the flag unset the application does not call the new RPCs. The production tip keeps the lesser contract: global and provider caps, about USD 3 per user per 24h (`PODCAST_SCRIPT_DAILY_USD`), and at most 3 attempts per long-script step.

## Threat model

The payer is the authenticated studio user. The app uses the service role, so the database must not trust a `project_id` string, an `authorization_ref`, or a `transaction_id` invented in TypeScript.

What we are stopping:

- A long-script step calling Anthropic on `studio-script:<user>:<job>` before any episode row exists, with no durable ceiling for that project.
- Crossing into the `podcast-` prefix to reuse `pi_spend_authorizations`. That prefix requires `podcast_episodes.user_id`. A pre-episode script cannot satisfy it, and the old `podcast-studio:` id left every call `RESERVED` (P0, 2026-11-01).
- The app asserting the triple itself. Service role can insert ledger rows. It must not be able to insert the authorization, the spend grant, or the episode binding.
- Two overlapping steps of the same job both passing the same remaining dollars.
- A second owner attaching their cap to someone else's job id.
- A closed, expired, or episode-bound authorization accepting another paid step.
- Treating an unreconciled refund as free budget.

What this does not claim:

- It does not replace the global or provider ceilings. Those still run in the predecessor of `pi_submit_with_supply`.
- It does not authorize HeyGen, audio, or MP4. Binding an episode does not add script dollars to `authorized_usd`.
- It is not a typed dollar confirmation in the wizard. The cap is the operator env (`PODCAST_SCRIPT_JOB_USD`, default the daily cap, hard max USD 50). The browser cannot raise it.
- A compromised service role can still call the open RPC. That is the same trust as `pi_open_spend_authorization`. The difference is that the caller cannot choose `transaction_id` or write the table directly.

## Why `studio-script:` stays, and why the episode gate does not grow

`requiresAuthorization` remains `podcast-` and `documentary:` only. `studio-script:` is a sibling branch inside `pi_submit_with_supply`, taken only when `lower(project_id) like 'studio-script:%'`.

- A canonical id is `studio-script:` + lowercase owner uuid + `:` + lowercase job uuid. Anything else with that prefix is refused as `authorization owner mismatch` and is not delegated.
- `podcast-…` and every other project fall through to the previous function, renamed once to `pi_submit_with_supply_pre_studio_script`. Execute on that inner function is revoked from `service_role`, so the new gate cannot be skipped by calling the predecessor. The security-definer wrapper still can.
- Owner proof, equivalent to reading `podcast_episodes.user_id`: the open RPC loads `auth.users`, builds the project id itself, and submit recomputes `pi_studio_script_project(owner_id, job_id)` and checks the user still exists. The embedded owner and the stored owner are the same column pair, protected by a CHECK and by an immutability trigger.

## Triple match

One row in `pi_studio_script_authorizations` is the triple:

| Part | Who sets it | Rule |
| --- | --- | --- |
| `project_id` | `pi_open_studio_script_authorization` | `studio-script:<owner>:<job>`, never a free argument |
| `authorization_ref` | the open RPC, from the server | App sends `studio-script-auth:<job>`. Immutable. A second open returns `already_open` and the original ref. |
| `transaction_id` | BEFORE INSERT trigger | Always `txid_current()` of the open transaction. A supplied value is overwritten. `service_role` has no INSERT. |

`pi_submit_with_supply` still receives only `(idempotency_key, units)`. After the row lock, the owner check, the expiry check, and the cap check, it calls the predecessor. If that returns `submitted: true`, the same transaction inserts `pi_studio_script_spend_grants` with the triple copied from the locked authorization. The grant trigger rejects a triple that does not match a row, and rejects any insert whose transaction-local GUC was not set by the wrapper.

An auditor can look for a submitted `studio-script:%` operation with no grant. Operations committed before this proposal exists (BASE DULCE, about USD 0.17) have no grant. They are not baselined away: opening an authorization later still counts that `COMMITTED` amount against the cap. `baseline_keys` stays `{}` on purpose. The episode opener baselines pre-existing settled keys because that cap was additional spend; here the historical script spend is part of the ceiling.

## Lifecycle

1. **Open.** `script-step`, only when `PODCAST_STUDIO_SCRIPT_DURABLE_AUTH=1`, calls `pi_open_studio_script_authorization` before `advanceLongScript`. Owner is the session user. Cap is the env ceiling. TTL is 24 hours (the SQL accepts any positive TTL up to 72 hours; a shorter TTL only expires sooner). Uncertain rows (`SUBMITTED`, `PROVIDER_JOB_RECORDED`, `RECONCILIATION_REQUIRED`) block the open. `RESERVED` rows do not count until they submit.
2. **Submit.** Each step (`plan-a1`, `s0-a2`, …, at most 3 attempts in `long-script.ts`) reserves in `pi_paid_operations` and then enters `pi_submit_with_supply`. The authorization row is locked `FOR UPDATE`. Usage counts `COMMITTED` at `committed_usd`, open reservations, and `REFUNDED` rows that are not `supply_reconciled`. `capacity_hold` is ignored. Over the cap, the row stays `RESERVED` and the predecessor is not called.
3. **Commit / reconcile.** Unchanged ledger paths. A later submit sees the committed actual and stops counting a reconciled refund. This proposal does not add a new reconcile RPC.
4. **Expire.** On submit or bind, an `ACTIVE` row with `expires_at <= clock_timestamp()` becomes `EXPIRED` and the call is refused. `pi_expire_studio_script_authorizations` can sweep the same predicate. It is not scheduled here. Expiry does not depend on a cron.
5. **Close.** `pi_close_studio_script_authorization` moves `ACTIVE` to `CLOSED`. Another owner does not name this project: their id is a different `studio-script:` string, so the RPC returns `authorization missing`.
6. **Bind.** After a draft `podcast_studio_episodes` row exists, `pi_bind_studio_script_authorization` requires the same `user_id`, status `draft`, and an `ACTIVE` unexpired authorization. It sets `BOUND`, writes `pi_studio_script_episode_bindings` with the same triple, and further script submits fail closed. Repeating the same pair returns `already_bound`. A second episode returns `job already bound`.

Terminal statuses (`CLOSED`, `EXPIRED`, `BOUND`) cannot return to `ACTIVE`. Cap, owner, ref, transaction id, expiry, and baseline cannot change.

## How episode creation inherits the authorization

The wizard keeps `scriptJobId` when a long script finishes and sends it on `create`. Editing the script text, or choosing the free template, clears it. With the flag off, `create` ignores the id.

With the flag on, `create` inserts the draft and then binds. If bind fails, it deletes that draft (status `draft`, same user) and returns an error. No video job is dispatched. The binding is an audit link: which script job, which triple, which episode, same owner. It does not move remaining script dollars into the episode media budget, and it does not satisfy `pi_open_spend_authorization` for `podcast-<episode>`. Media spend stays on the episode gate.

If `podcast_studio_episodes` is missing, bind returns `studio episodes table missing` and the draft is removed. The proposal uses dynamic SQL for that lookup so it can be applied before the studio table exists; bind then fail-closes.

## Why this is stronger than the daily cap alone

The daily cap is an application read of the last 24 hours across every `studio-script:<user>:%` project. Two requests can both read "under the cap" and both call the provider. It forgets spend when the window moves. It has no `authorization_ref` and no database `transaction_id`. It cannot prove which open authorized a given ledger key.

The durable row is locked during submit, so two steps share one remaining amount. The cap does not reset when the day changes; it expires or closes. Every admitted key has a grant whose triple was copied inside the database. Historical `COMMITTED` spend on that project counts. The predecessor's global and provider ceilings still apply. The daily cap stays in `script-step` as the cross-job sum. Neither layer is optional once the flag is on: the read failing is 503, and the RPC failing is 503 or 409, both before the model.

## Activation matrix

| Flag | Proposal applied | What a script step does |
| --- | --- | --- |
| off | no | Today's lesser contract. No new RPC. This PR. |
| on | no | 503. The RPC is missing. No Anthropic call. |
| off | yes | The app still tries the call. `pi_submit_with_supply` refuses `studio-script:%` with `authorization missing`. The provider is not called. Script generation stops until the flag is turned on. |
| on | yes | Open, then submit under the triple. Bind on episode create. |

Do not set the flag before the proposal is applied. Do not apply the proposal and leave the flag off if script generation should keep working: the database becomes fail-closed on purpose.

Order when a later review says yes: deploy this application with the flag still off, apply the proposal in its own reviewed window, then set `PODCAST_STUDIO_SCRIPT_DURABLE_AUTH=1`. Roll back by running the rollback SQL (restores the previous `pi_submit_with_supply` and grants `service_role` execute on it) and unsetting the flag. The rollback keeps the three tables and their immutability triggers. Drop them only if they are empty and that loss is accepted.

## App wiring

- `src/lib/podcast/studio-script-authorization.ts` — flag, cap, open, bind, and `decideStudioScriptSubmit` (the executable spec of the SQL branch).
- `src/lib/podcast/v3/api.ts` `script-step` — daily cap, then the durable open when the flag is on. The HTTP body does not include `transactionId`.
- `src/app/api/podcast/v3/route.ts` — passes the RPCs only when the flag is `1`, and deletes a draft if bind fails.
- `src/lib/podcast/v3/adapters.ts` `realLlmStep` — still the supply call. It does not open an authorization and does not invent a transaction id. Comments mark the migration as not applied.
- `src/lib/supply/spend-authorization.ts` — `studio-script:` stays out of `AUTHORIZATION_REQUIRED_PREFIXES`.

## Out of scope

HeyGen, ElevenLabs audio, MP4, episode media caps, and scheduling the expiry sweeper. Those stay on their existing gates.
