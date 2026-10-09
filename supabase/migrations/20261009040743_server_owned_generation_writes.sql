-- Apply AFTER the web deployment routes creation through the validated server action.
-- RLS still protects reads. Workers and server actions retain service_role access.
-- Revoke both table and column grants: revoking only one does not remove the other.
set local lock_timeout = '3s';

revoke insert, update, delete, truncate, references, trigger
  on public.video_requests, public.avatars from public, anon, authenticated;

do $$
declare
  target text;
  columns text;
begin
  foreach target in array array['video_requests', 'avatars'] loop
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns
      from pg_attribute
      where attrelid = format('public.%I', target)::regclass
        and attnum > 0 and not attisdropped;
    execute format('revoke insert (%s), update (%s), references (%s) on public.%I from public, anon, authenticated',
      columns, columns, columns, target);
  end loop;
end $$;
