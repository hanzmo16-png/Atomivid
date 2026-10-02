-- 0031: Clients cannot write server-owned columns of public.video_requests (PI V2 Fase B3.1, RB-06).
-- Finding (docs/audits/PI-V2-REALITY-CHECK.md, RB-06): the 0001 insert policy only checks
-- auth.uid() = user_id, and Supabase's default grants give anon/authenticated INSERT and UPDATE on
-- every column. A client calling PostgREST directly could therefore create its own row already
-- 'completed', with a forged video_path, a past created_at (monthly quota), any render_attempts
-- (attempt cap) and a forged confirmed Long Form plan (budget).
--
-- Guard, scoped to this one table and to the two client roles only:
--   1. Protected columns are never client-writable, on INSERT or UPDATE:
--        video_path, created_at, render_attempts, long_form_production_plan, long_form_confirmed_at
--      Postgres cannot revoke a single column while a table-level privilege exists, so the table-level
--      INSERT/UPDATE of anon/authenticated is revoked and re-granted on every CURRENT column except
--      those five. A column added by a later migration is not client-writable until that migration
--      grants it explicitly (fail closed).
--   2. One RESTRICTIVE policy per write command pins what a client row may look like:
--        user_id = auth.uid() and status in ('pending','script_ready').
--      Restrictive policies are AND-ed with the existing permissive ones; the 0001 policies are not
--      rewritten. There is still no permissive UPDATE policy, so clients still update nothing; the
--      update guard only matters if one is ever added.
--   3. service_role is not touched: it keeps its grants and BYPASSRLS, so the worker still writes
--      status/video_path/render_attempts when a job ends.
-- No trigger. No data change. Re-runnable: every statement is idempotent.
-- Rollback (manual): grant insert, update on public.video_requests to anon, authenticated;
--   drop policy "Clients insert only their own pre-render rows" on public.video_requests;
--   drop policy "Clients update only their own pre-render rows" on public.video_requests;

revoke insert, update on public.video_requests from anon, authenticated;

do $$
declare
  cols text;
begin
  select string_agg(format('%I', column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'video_requests'
     and column_name not in ('video_path', 'created_at', 'render_attempts', 'long_form_production_plan', 'long_form_confirmed_at');
  execute format('grant insert (%s), update (%s) on public.video_requests to anon, authenticated', cols, cols);
end $$;

drop policy if exists "Clients insert only their own pre-render rows" on public.video_requests;
create policy "Clients insert only their own pre-render rows"
  on public.video_requests
  as restrictive
  for insert
  to anon, authenticated
  with check (user_id = auth.uid() and status in ('pending', 'script_ready'));

drop policy if exists "Clients update only their own pre-render rows" on public.video_requests;
create policy "Clients update only their own pre-render rows"
  on public.video_requests
  as restrictive
  for update
  to anon, authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and status in ('pending', 'script_ready'));
