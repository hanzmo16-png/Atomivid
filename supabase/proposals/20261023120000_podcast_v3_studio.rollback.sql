-- Reversión de la propuesta Podcast 3.0. Solo borra las tablas nuevas (no toca podcast_episodes).
-- ATENCIÓN: borra episodios de estudio y su libro de operaciones; exporta antes si hubo uso real.
drop table if exists public.podcast_studio_operations;
drop table if exists public.podcast_studio_episodes;
