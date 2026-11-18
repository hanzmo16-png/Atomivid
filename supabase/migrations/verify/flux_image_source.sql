-- Disposable local PostgreSQL only: psql -d <throwaway> -f supabase/migrations/verify/flux_image_source.sql (from the repo root).
-- Applies the Recraft migrations + 20261113150000_flux_image_source.sql on a minimal stub and ASSERTS each transition.
\set ON_ERROR_STOP 1
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.video_requests(id uuid primary key default gen_random_uuid(), mode text not null, long_form_confirmed_at timestamptz, status text);
create table public.pi_supply_policies(provider text primary key, unit text, evidence text, enabled boolean default false,
  daily_cap_usd numeric default 0, monthly_cap_usd numeric default 0);
create table public.pi_provider_accounts(provider text primary key, production_account_label text, plan text, secret_reference_name text, status text, balance_source text);
\i supabase/migrations/20261021090000_reel_recraft_images.sql
\i supabase/migrations/20261021160000_long_form_recraft_images.sql
\i supabase/migrations/20261113150000_flux_image_source.sql
-- Idempotent re-run of the inserts (on conflict do nothing) must not fail.
insert into public.pi_supply_policies(provider, unit, evidence) values ('flux','usd','x') on conflict (provider) do nothing;

create function pg_temp.expect_error(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS (refused) %', label; return; end;
  raise exception 'FAIL: % was accepted', label;
end $$;
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL: %', label; end if; end $$;

-- 1 Reel created with flux, no style: ok
insert into video_requests(id,mode,reel_image_source) values ('00000000-0000-0000-0000-0000000000f1','visual','flux');
select pg_temp.check((select reel_image_source from video_requests where id='00000000-0000-0000-0000-0000000000f1')='flux', 'Reel insert flux');
-- 2 flux with a Recraft style is refused
select pg_temp.expect_error($q$insert into video_requests(mode,reel_image_source,reel_recraft_style) values ('visual','flux','{"styleId":null}')$q$, 'flux + recraft style');
-- 3 flux with a style_id is refused
select pg_temp.expect_error($q$update video_requests set reel_recraft_style_id='style-aaaa-1111' where id='00000000-0000-0000-0000-0000000000f1'$q$, 'flux + style_id');
-- 4 Reel source cannot change after insert
select pg_temp.expect_error($q$update video_requests set reel_image_source='default' where id='00000000-0000-0000-0000-0000000000f1'$q$, 'Reel flux -> default');
-- 5 Long Form confirmed WITH flux in one update: ok; changing it later refused
insert into video_requests(id,mode,status) values ('00000000-0000-0000-0000-0000000000f2','long_form','script_ready');
update video_requests set reel_image_source='flux', long_form_confirmed_at=now() where id='00000000-0000-0000-0000-0000000000f2';
select pg_temp.check((select reel_image_source from video_requests where id='00000000-0000-0000-0000-0000000000f2')='flux', 'LF confirm with flux');
select pg_temp.expect_error($q$update video_requests set reel_image_source='recraft', reel_recraft_style='{}' where id='00000000-0000-0000-0000-0000000000f2'$q$, 'LF flux -> recraft');
-- 6 LF choice without the confirmation in the same update is refused
insert into video_requests(id,mode,status) values ('00000000-0000-0000-0000-0000000000f3','long_form','script_ready');
select pg_temp.expect_error($q$update video_requests set reel_image_source='flux' where id='00000000-0000-0000-0000-0000000000f3'$q$, 'LF flux without confirmation');
-- 7 avatar mode cannot pick flux; unknown sources still refused
select pg_temp.expect_error($q$insert into video_requests(mode,reel_image_source) values ('avatar','flux')$q$, 'avatar + flux');
select pg_temp.expect_error($q$insert into video_requests(mode,reel_image_source) values ('visual','openai')$q$, 'unknown source');
-- 8 Recraft unchanged: Reel insert with recraft still ok
insert into video_requests(id,mode,reel_image_source,reel_recraft_style) values ('00000000-0000-0000-0000-0000000000f4','visual','recraft','{"styleId":null,"referencePaths":["a"]}');
select pg_temp.check(true, 'Recraft Reel insert still accepted');
-- 9 policy CLOSED and account row present (secret NAME only)
select pg_temp.check((select enabled = false and daily_cap_usd = 0 and monthly_cap_usd = 0 from pi_supply_policies where provider='flux'), 'flux policy closed');
select pg_temp.check((select secret_reference_name='FAL_ADMIN_KEY' and status='unknown' from pi_provider_accounts where provider='flux'), 'flux provider account');
select 'ALL FLUX MIGRATION CHECKS PASSED' as result;
