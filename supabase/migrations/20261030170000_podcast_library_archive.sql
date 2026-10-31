-- Podcast — biblioteca limpia (T-20261030-1118). Aplicación autorizada por Hans el 2026-10-31 («Autorizo aplicar la migración
-- archived_at del PR #254»). Reversión: supabase/rollbacks/20261030170000_podcast_library_archive.rollback.sql.
-- Solo añade una marca de archivo por episodio. No borra ni mueve filas, archivos, enlaces, costos ni el libro de gastos.
-- Escritura: solo el servidor (service_role) desde /api/podcast/library con comprobación de dueño; los permisos de
-- anon/authenticated no cambian (siguen sin UPDATE) y las políticas de lectura del dueño siguen iguales.
alter table public.podcast_studio_episodes add column if not exists archived_at timestamptz;
alter table public.podcast_episodes add column if not exists archived_at timestamptz;
create index if not exists podcast_studio_episodes_user_archived on public.podcast_studio_episodes (user_id, archived_at);
create index if not exists podcast_episodes_user_archived on public.podcast_episodes (user_id, archived_at);
-- PostgREST: que la API vea la columna nueva sin esperar (se entrega al confirmar la transacción).
notify pgrst, 'reload schema';
