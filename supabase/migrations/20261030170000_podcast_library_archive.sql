-- Podcast — biblioteca limpia (T-20261030-1118). Aplicación autorizada por Hans el 2026-10-31 («Autorizo aplicar la migración
-- archived_at del PR #254»). Reversión: supabase/rollbacks/20261030170000_podcast_library_archive.rollback.sql.
-- Solo añade una marca de archivo por episodio. No borra ni mueve filas, archivos, enlaces, costos ni el libro de gastos.
-- Escritura: solo el servidor (service_role) desde /api/podcast/library con comprobación de dueño; los permisos de
-- anon/authenticated no cambian (siguen sin UPDATE) y las políticas de lectura del dueño siguen iguales.
alter table public.podcast_episodes add column if not exists archived_at timestamptz;
create index if not exists podcast_episodes_user_archived on public.podcast_episodes (user_id, archived_at);
-- La tabla del estudio la crea supabase/proposals/20261024140000_podcast_v3_studio.sql (aplicada en producción por su propio
-- camino); en bases que solo cargan supabase/migrations no existe, así que esta parte solo corre si la tabla está.
do $$
begin
  if to_regclass('public.podcast_studio_episodes') is not null then
    alter table public.podcast_studio_episodes add column if not exists archived_at timestamptz;
    create index if not exists podcast_studio_episodes_user_archived on public.podcast_studio_episodes (user_id, archived_at);
  end if;
end $$;
-- PostgREST: que la API vea la columna nueva sin esperar (se entrega al confirmar la transacción).
notify pgrst, 'reload schema';
