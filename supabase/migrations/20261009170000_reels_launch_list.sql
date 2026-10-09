-- Reels/Shorts launch list: same server-only table as the documentaries early-access list, one more product.
-- The funnel report now also breaks list sign-ups down by product. Additive only.
set local lock_timeout = '3s';

-- The original inline check was named by Postgres; remove whichever check constrains "product" before adding the new one.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.early_access_requests'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%product%'
  loop
    execute format('alter table public.early_access_requests drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.early_access_requests add constraint early_access_requests_product_check check (product in ('documentales','reels'));

create or replace function public.marketing_funnel(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'events', coalesce((select jsonb_object_agg(event, jsonb_build_object('count', n, 'people', people)) from (
       select event, count(*) as n, count(distinct coalesce(user_id::text, visitor_id::text)) as people
       from public.marketing_events where created_at >= p_from and created_at < p_to group by event) ev), '{}'::jsonb),
    'cta_clicks', coalesce((select jsonb_object_agg(cta, n) from (select cta, count(*) as n from public.marketing_events
       where event = 'cta_click' and created_at >= p_from and created_at < p_to group by cta) c), '{}'::jsonb),
    'early_access_requests', (select count(*) from public.early_access_requests where created_at >= p_from and created_at < p_to),
    'list_requests_by_product', coalesce((select jsonb_object_agg(product, n) from (select product, count(*) as n
       from public.early_access_requests where created_at >= p_from and created_at < p_to group by product) p), '{}'::jsonb)
  );
$$;
revoke all on function public.marketing_funnel(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.marketing_funnel(timestamptz, timestamptz) to service_role;
