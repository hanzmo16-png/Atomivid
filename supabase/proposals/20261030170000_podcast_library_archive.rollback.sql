-- Reversión de 20261030170000_podcast_library_archive.sql: quita la marca de archivo (los episodios vuelven a verse todos).
drop index if exists public.podcast_studio_episodes_user_archived;
drop index if exists public.podcast_episodes_user_archived;
alter table public.podcast_studio_episodes drop column if exists archived_at;
alter table public.podcast_episodes drop column if exists archived_at;
