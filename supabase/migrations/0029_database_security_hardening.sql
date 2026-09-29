-- 0029: Database security hardening V1 (surgical, idempotent, no data change, no product behaviour change).
-- Closes three Supabase Security Advisor findings without touching performance findings or auth settings:
--   1. public.yt_video_experiment ran with owner (definer-like) permissions and was readable by clients
--      through Supabase's default grants. It has no application consumer (service-role reports only), so it
--      becomes security_invoker (RLS of the underlying tables applies to whoever selects) AND client roles
--      lose every privilege on it. Most restrictive compatible option: backend/service-role only.
--   2. public._migrations_applied (migration registry) had RLS disabled and default client grants. RLS is
--      enabled with NO policies: anon/authenticated cannot read or write it; the migration runner connects as
--      the table owner (postgres), which bypasses RLS, and service_role keeps BYPASSRLS, so the runner and
--      youtube:doctor keep working. No USING (true) policy anywhere.
--   3. Six trigger functions had a mutable search_path. They are pinned to pg_catalog, public — every object
--      they reference is schema-qualified or a builtin, so behaviour is unchanged. No body/arguments/return change.
-- Re-runnable: every statement is idempotent. Nothing is dropped, deleted or rewritten.

-- 1. Experiment view: invoker semantics + no client access.
alter view public.yt_video_experiment set (security_invoker = true);
revoke all on public.yt_video_experiment from anon, authenticated;

-- 2. Migration registry: created by the runner (same DDL) if it does not exist yet, so a fresh database
--    applying 0001-0029 as raw SQL hardens the same table the runner will use.
create table if not exists public._migrations_applied (
  name text primary key,
  applied_at timestamptz not null default now()
);
alter table public._migrations_applied enable row level security;
revoke all on public._migrations_applied from anon, authenticated;

-- 3. Trigger functions: explicit, minimal search_path (pg_catalog first, then public).
alter function public.enforce_tts_monthly_limit() set search_path = pg_catalog, public;
alter function public.enforce_user_voice_limits() set search_path = pg_catalog, public;
alter function public.pi_reject_mutation() set search_path = pg_catalog, public;
alter function public.pi_paid_operation_forward_only() set search_path = pg_catalog, public;
alter function public.fc_append_only() set search_path = pg_catalog, public;
alter function public.yt_snapshot_final() set search_path = pg_catalog, public;
