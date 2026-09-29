# Database Security Hardening V1 — migration 0029 (NOT applied to production)

Status: **READY FOR PRODUCTION AUTHORIZATION**. Nothing in this mission was written to production:
the only production access was a read-only catalog inspection inside a `read only` transaction
(`scripts/db-security-preflight.ts`, workflow `db-security-preflight.yml`, run 36600998889, rolled back).
Applying `0029_database_security_hardening.sql` requires a new explicit human authorization.

## Production preflight (REGLA #0) — real state observed on 2026-09-29

| Fact | Observed |
| --- | --- |
| Runner role | `postgres` (session_user = current_user), `rolbypassrls = true`, not superuser; reached through the Supavisor pooler with the DB password (`SUPABASE_DB_URL` absent, `SUPABASE_DB_HOST` unset in secrets → passed as `pooler_host`, the same host the successful apply run of 2026-09-27 used) |
| Registry `_migrations_applied` | owner `postgres`, RLS **disabled**, 0 policies, ACL grants ALL (`arwdDxtm`) to `anon`, `authenticated`, `service_role`; rows **0001–0022 only** |
| 0023–0028 | every table/index/sequence present with RLS enabled, but **NOT registered** in `_migrations_applied` (applied outside the runner; no apply-workflow run exists after 2026-09-27) |
| Row counts | video_requests 33 · generation_costs 19 · subscriptions 1 · avatars 6 · user_voices 1 · tts_jobs 1 — identical to the mission baseline |
| View `yt_video_experiment` | owner `postgres`, `reloptions = null` (definer-like semantics: RLS of `yt_video_links`, `yt_performance_snapshots`, `fc_master_metrics` evaluated as the owner, who bypasses RLS), ACL grants ALL to `anon`/`authenticated`/`service_role` |
| Six trigger functions | owner `postgres`, `prosecdef = false`, `proconfig = null` (mutable `search_path`); all 13 triggers enabled (`O`) |
| PI / Final Cut / delivery / OAuth tables | RLS enabled, 0 policies (service-role-only by design), default client grants present but blocked by RLS — untouched |
| Default privileges | `postgres` and `supabase_admin` grant ALL on new tables/sequences/functions in `public` to `anon`, `authenticated`, `service_role` (this is why the view and the registry were client-readable) |
| Backup / PITR | **UNVERIFIED** — not queryable from SQL; the Supabase dashboard / Management API were not accessed. No restore point is claimed. |

The view had no application consumer (docs only); `_migrations_applied` is read by
`scripts/apply-supabase-migration.ts` (as owner) and `scripts/youtube-doctor.ts` (service role).

## What 0029 does (idempotent, no data change)

1. `alter view public.yt_video_experiment set (security_invoker = true)` + `revoke all … from anon, authenticated`.
   Most restrictive compatible option: the view stays for backend/service-role reports, clients lose all
   privileges, and even a future re-grant would enforce the underlying RLS for the caller.
2. `create table if not exists public._migrations_applied (…)` (runner DDL, no-op in production) +
   `enable row level security` + `revoke all … from anon, authenticated`. **No policy** (no `USING (true)`).
   The runner connects as the owner (BYPASSRLS) and `service_role` keeps its grants and BYPASSRLS.
3. `alter function public.<fn>() set search_path = pg_catalog, public` for `enforce_tts_monthly_limit`,
   `enforce_user_voice_limits`, `pi_reject_mutation`, `pi_paid_operation_forward_only`, `fc_append_only`,
   `yt_snapshot_final`. Bodies, arguments, return types and triggers unchanged (all references are
   schema-qualified or builtins).

## Local validation (Postgres 16, fresh database)

- Stub + 0001→0029 applied cleanly; 0029 re-applied: no-op (`NOTICE: relation already exists, skipping`).
- verify 01/03/04/05/06 still pass; new verify 07 passes (19 explicit checks — see verify/README.md).
- Runner rehearsal (`SUPABASE_DB_URL` → local DB mirroring production: 0001–0022 registered, 0023–0028
  objects present but unregistered, Supabase default grants simulated): the real
  `scripts/apply-supabase-migration.ts` applied 0023–0029 and registered them; a second run skips 29.
  Destructive-line detector: 0 hits for 0029.
- Runner compatibility after 0029: owner insert/select/delete on the registry verified; service_role select verified.

## Expected Security Advisor changes after 0029

| Finding | Expected |
| --- | --- |
| `security_definer_view` on `public.yt_video_experiment` | CLOSED |
| `rls_disabled_in_public` on `public._migrations_applied` | CLOSED |
| `function_search_path_mutable` × 6 | CLOSED |
| INFO `rls_enabled_no_policy` on PI / Final Cut / delivery / OAuth tables | UNCHANGED (intentional, service-role-only) — now also on `_migrations_applied` |
| Performance findings (unindexed FKs, `auth_rls_initplan`, unused indexes, Auth DB connection strategy) | UNCHANGED — out of scope, pending separately |
| Auth "Leaked Password Protection Disabled" | UNCHANGED — dashboard setting, pending separately |

## Discrepancies and pending items (the real state wins)

- **0023–0028 are not registered in `_migrations_applied`.** If 0029 is applied through the runner, it
  will first re-execute 0023–0028 (they are re-runnable: verified twice locally and in the rehearsal) and
  register them, then apply 0029. If 0029 is applied by hand in the SQL editor instead, register 0023–0029
  manually as was done for 0020–0022, or the next runner invocation re-executes them. Extending
  `scripts/lib/migration-schema-map.ts` with 0020–0029 checks would make the runner reconcile instead of
  re-execute; not done here (out of this mission's surface).
- `SUPABASE_DB_HOST` is not set as a repository secret: every DB workflow needs `pooler_host` on dispatch.
- Backup/PITR capability was not demonstrated. Take (or confirm) a backup before authorizing 0029.
- Google OAuth for YouTube remains unconfigured (STILL BLOCKED); nothing here touches it.
