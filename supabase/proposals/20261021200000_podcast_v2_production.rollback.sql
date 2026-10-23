-- Reversión de la propuesta Podcast 2.0. Antes: dejar PODCAST_V2_ENABLED sin definir y redeplegar (la app vuelve a no leer las columnas).
-- Copia previa: borrar las columnas destruye la producción por turnos de los episodios v2. Se conserva en una tabla
-- con RLS activa y SIN políticas (solo service role); al re-aplicar la propuesta se restaura con:
--   update public.podcast_episodes e set production=b.production, production_timeline=b.production_timeline,
--       source=b.prev_source, script=b.prev_script, status=case when b.prev_status='generating' then 'failed' else b.prev_status end,
--       video_status=case when e.video_status is distinct from (case when b.prev_video_status in ('scheduled','queued') then 'blocked' else b.prev_video_status end)
--         then e.video_status when b.prev_video_status in ('scheduled','queued') then 'blocked' when b.prev_video_status='running' then 'failed' else b.prev_video_status end,
--       budget_usd=case when e.budget_usd = 0 then b.prev_budget_usd else e.budget_usd end, error=b.prev_error
--     from public.podcast_episodes_v2_rollback_backup b where b.id=e.id and e.error=b.marker;
-- Solo filas aún neutralizadas (e.error = marcador): una fila que el dueño cambió mientras tanto (p. ej. subió su
-- grabación) se deja como está; si solo produjo un video en la ventana, se conservan su video y su presupuesto. Un video
-- que estaba programado/en cola vuelve BLOQUEADO (su hora ya pasó: el dueño lo reprograma), nunca se re-arma solo, y uno
-- «en curso» vuelve fallido (esa ejecución ya terminó).
-- Neutralización: sin la columna `production` (o con el código anterior) un episodio v2 se narraría como 1.x — solo la
-- voz A, leyendo las etiquetas «A: …» del guion y sintetizando por TTS los turnos con grabación propia — y se cobraría,
-- incluso solo (tick programado). El presupuesto no basta: «Producir ahora» lo reescribe desde el formulario. Antes de
-- borrar las columnas cada episodio v2 pasa a source='upload' sin guion: el código 1.x rechaza ahí generar, narrar en
-- segundo plano y producir video sin grabación lista (una entrega ya lista conserva su audio y no se re-narra). Además:
-- presupuesto 0, borrador/fallido → fallido, video programado/en cola → bloqueado. El estado previo va a la copia;
-- una segunda reversión solo lo refresca si la fila ya no está neutralizada (aviso distinto de NEUTRALIZED).
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='podcast_episodes' and column_name='production') then
    create table if not exists public.podcast_episodes_v2_rollback_backup(id uuid primary key, production jsonb, production_timeline jsonb, saved_at timestamptz not null default now());
    alter table public.podcast_episodes_v2_rollback_backup enable row level security;
    revoke all on public.podcast_episodes_v2_rollback_backup from anon, authenticated;
    alter table public.podcast_episodes_v2_rollback_backup
      add column if not exists prev_status text, add column if not exists prev_video_status text,
      add column if not exists prev_budget_usd numeric(12,4), add column if not exists prev_error text,
      add column if not exists prev_source text, add column if not exists prev_script text,
      add column if not exists marker text not null default 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.';
    insert into public.podcast_episodes_v2_rollback_backup as b(id, production, production_timeline, prev_status, prev_video_status, prev_budget_usd, prev_error, prev_source, prev_script)
      select id, production, production_timeline, status, video_status, budget_usd, error, source, script from public.podcast_episodes where production is not null or production_timeline is not null
      on conflict (id) do update set production=excluded.production, production_timeline=excluded.production_timeline, saved_at=now(),
        -- fila ya neutralizada (re-ejecución): conservar el estado original; fila restaurada y usada: guardar el actual.
        prev_status = case when excluded.prev_error is distinct from 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.' then excluded.prev_status else b.prev_status end,
        prev_video_status = case when excluded.prev_error is distinct from 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.' then excluded.prev_video_status else b.prev_video_status end,
        prev_budget_usd = case when excluded.prev_error is distinct from 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.' then excluded.prev_budget_usd else b.prev_budget_usd end,
        prev_source = case when excluded.prev_error is distinct from 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.' then excluded.prev_source else b.prev_source end,
        prev_script = case when excluded.prev_error is distinct from 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.' then excluded.prev_script else b.prev_script end,
        prev_error = case when excluded.prev_error is distinct from 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.' then excluded.prev_error else b.prev_error end;
    update public.podcast_episodes set
        source = 'upload',
        script = null,
        budget_usd = 0,
        -- generating: sin el flag esa ejecución ya no termina; fallido deja al dueño salir del estado.
        status = case when status in ('draft','failed','generating') then 'failed' else status end,
        scheduled_at = null,
        -- sin token una ejecución que siguiera viva no puede escribir «listo» encima de la neutralización
        run_token = case when status = 'generating' then null else run_token end,
        error = 'NEUTRALIZED: Episodio de Podcast 2.x retirado por reversión; restaurar su producción por turnos para volver a generar.',
        video_status = case when video_status in ('scheduled','queued') then 'blocked' else video_status end,
        updated_at = now()
      where production is not null;
  end if;
end $$;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_timeline_shape;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_production_shape;
alter table public.podcast_episodes drop column if exists production_timeline;
alter table public.podcast_episodes drop column if exists production;
