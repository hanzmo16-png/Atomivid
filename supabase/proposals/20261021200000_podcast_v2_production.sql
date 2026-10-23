-- PROPUESTA (NO APLICADA). Podcast 2.0: producción estructurada por turnos y su línea de tiempo.
-- Requiere autorización explícita de Hans para aplicarse. Mientras no exista, PODCAST_V2_ENABLED debe seguir sin definir.
-- RLS: la tabla ya es solo-lectura del dueño (podcast_episodes_owner_read) y toda escritura va por service role;
-- las columnas nuevas heredan esa política. No se tocan pi_paid_operations ni el ledger.
alter table public.podcast_episodes
  add column if not exists production jsonb,
  add column if not exists production_timeline jsonb;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_production_shape;
alter table public.podcast_episodes add constraint podcast_episodes_production_shape check (
  -- coalesce(..., false): con un array, un escalar o una clave ausente `->>` da NULL, y un CHECK NULL se acepta.
  production is null or coalesce(
    jsonb_typeof(production) = 'object'
    and production->>'version' = 'podcast-production/1'
    and production->>'mode' in ('single','conversation')
    and production->>'style' in ('standard','emotional')
    and jsonb_typeof(production->'turns') = 'array'
    and jsonb_array_length(production->'turns') between 1 and 400
    and pg_column_size(production) <= 262144
  , false)
);
alter table public.podcast_episodes drop constraint if exists podcast_episodes_timeline_shape;
alter table public.podcast_episodes add constraint podcast_episodes_timeline_shape check (production_timeline is null or jsonb_typeof(production_timeline) = 'array');
comment on column public.podcast_episodes.production is 'Podcast 2.0: modo, estilo, participantes (voz o grabación propia por turno) y turnos con ID estable.';
