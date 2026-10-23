-- Reversión de la propuesta Podcast 2.0. Antes: dejar PODCAST_V2_ENABLED sin definir y redeplegar (la app vuelve a no leer las columnas).
-- Copia previa: borrar las columnas destruye la producción por turnos de los episodios v2. Se conserva en una tabla
-- con RLS activa y SIN políticas (solo service role); al re-aplicar la propuesta se restaura con:
--   update public.podcast_episodes e set production=b.production, production_timeline=b.production_timeline,
--       status=b.prev_status, video_status=b.prev_video_status, budget_usd=b.prev_budget_usd, error=b.prev_error
--     from public.podcast_episodes_v2_rollback_backup b where b.id=e.id;
-- Neutralización: sin la columna `production` (o con el código anterior) un episodio v2 se narraría como 1.x — solo la
-- voz A, leyendo las etiquetas «A: …» del guion y sintetizando por TTS los turnos con grabación propia — y se cobraría,
-- incluso solo (tick programado). Antes de borrar las columnas, cada episodio v2 queda sin poder generar gasto:
-- presupuesto 0 (la generación y el arranque programado lo exigen), borrador/fallido → fallido con aviso, y video
-- programado/en cola → bloqueado. El estado previo se guarda en la copia para restaurarlo.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='podcast_episodes' and column_name='production') then
    create table if not exists public.podcast_episodes_v2_rollback_backup(id uuid primary key, production jsonb, production_timeline jsonb, saved_at timestamptz not null default now());
    alter table public.podcast_episodes_v2_rollback_backup enable row level security;
    revoke all on public.podcast_episodes_v2_rollback_backup from anon, authenticated;
    alter table public.podcast_episodes_v2_rollback_backup
      add column if not exists prev_status text, add column if not exists prev_video_status text,
      add column if not exists prev_budget_usd numeric(12,4), add column if not exists prev_error text;
    -- prev_* solo al insertar: una segunda ejecución no pisa el estado original con el ya neutralizado.
    insert into public.podcast_episodes_v2_rollback_backup(id, production, production_timeline, prev_status, prev_video_status, prev_budget_usd, prev_error)
      select id, production, production_timeline, status, video_status, budget_usd, error from public.podcast_episodes where production is not null or production_timeline is not null
      on conflict (id) do update set production=excluded.production, production_timeline=excluded.production_timeline, saved_at=now();
    update public.podcast_episodes set
        budget_usd = 0,
        status = case when status in ('draft','failed') then 'failed' else status end,
        error = case when status in ('draft','failed') then 'Episodio de Podcast 2.x retirado por reversión: no se puede generar hasta restaurar su producción por turnos.' else error end,
        video_status = case when video_status in ('scheduled','queued') then 'blocked' else video_status end,
        updated_at = now()
      where production is not null;
  end if;
end $$;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_timeline_shape;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_production_shape;
alter table public.podcast_episodes drop column if exists production_timeline;
alter table public.podcast_episodes drop column if exists production;
