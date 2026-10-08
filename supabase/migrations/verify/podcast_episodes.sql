-- Verifies the podcast_episodes migration (read-only).
do $$ begin
  if to_regclass('public.podcast_episodes') is null then raise exception 'podcast_episodes missing'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.podcast_episodes'::regclass) then raise exception 'RLS off'; end if;
  if has_table_privilege('authenticated', 'public.podcast_episodes', 'INSERT') then raise exception 'authenticated can insert'; end if;
end $$;
