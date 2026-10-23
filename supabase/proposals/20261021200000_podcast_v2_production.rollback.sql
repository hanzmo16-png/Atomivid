-- Reversión de la propuesta Podcast 2.0. Antes: dejar PODCAST_V2_ENABLED sin definir y redeplegar (la app vuelve a no leer las columnas).
-- Copia previa: borrar las columnas destruye la producción por turnos de los episodios v2. Se conserva en una tabla
-- con RLS activa y SIN políticas (solo service role); al re-aplicar la propuesta se restaura con:
--   update public.podcast_episodes e set production=b.production, production_timeline=b.production_timeline
--     from public.podcast_episodes_v2_rollback_backup b where b.id=e.id;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='podcast_episodes' and column_name='production') then
    create table if not exists public.podcast_episodes_v2_rollback_backup(id uuid primary key, production jsonb, production_timeline jsonb, saved_at timestamptz not null default now());
    alter table public.podcast_episodes_v2_rollback_backup enable row level security;
    revoke all on public.podcast_episodes_v2_rollback_backup from anon, authenticated;
    insert into public.podcast_episodes_v2_rollback_backup(id, production, production_timeline)
      select id, production, production_timeline from public.podcast_episodes where production is not null or production_timeline is not null
      on conflict (id) do update set production=excluded.production, production_timeline=excluded.production_timeline, saved_at=now();
  end if;
end $$;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_timeline_shape;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_production_shape;
alter table public.podcast_episodes drop column if exists production_timeline;
alter table public.podcast_episodes drop column if exists production;
