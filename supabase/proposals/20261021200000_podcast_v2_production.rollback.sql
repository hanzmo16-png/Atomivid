-- Reversión de la propuesta Podcast 2.0. Antes: dejar PODCAST_V2_ENABLED sin definir y redeplegar (la app vuelve a no leer las columnas).
alter table public.podcast_episodes drop constraint if exists podcast_episodes_timeline_shape;
alter table public.podcast_episodes drop constraint if exists podcast_episodes_production_shape;
alter table public.podcast_episodes drop column if exists production_timeline;
alter table public.podcast_episodes drop column if exists production;
