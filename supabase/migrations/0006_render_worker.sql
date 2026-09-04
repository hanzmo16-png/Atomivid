-- Atomivid — worker de render en segundo plano (GitHub Actions) + Storage
-- privado con URLs firmadas.
--
-- No hay datos reales en producción todavía (confirmado antes de este
-- cambio), así que no se necesita backfill: los renders futuros usan las
-- columnas nuevas desde el primer request.

-- Seguimiento del trabajo de render: cuántos intentos lleva, cuándo empezó
-- el intento actual (para detectar un render colgado/timeout) y qué worker
-- lo procesó (para poder alternar entre GitHub Actions / inline / un
-- futuro worker de pago sin perder el historial).
alter table public.video_requests
  add column if not exists render_attempts integer not null default 0;

alter table public.video_requests
  add column if not exists render_started_at timestamptz;

alter table public.video_requests
  add column if not exists render_worker text;

-- El video final ahora se referencia por su ruta dentro del bucket
-- (no por una URL pública) — el bucket deja de ser público (ver abajo) y
-- las URLs de reproducción/descarga se firman bajo demanda, validando
-- primero que el usuario sea dueño del request. `video_url` se conserva
-- sin usar por compatibilidad hacia atrás (no se elimina una columna con
-- una migración destructiva), pero el código ya no la escribe ni la lee.
alter table public.video_requests
  add column if not exists video_path text;

-- Bucket privado: los assets intermedios (voz/footage/música) y el video
-- final ahora se sirven con URLs firmadas de corta duración, generadas
-- solo después de validar que el usuario es dueño del request (o, para los
-- assets intermedios usados durante el render, generadas por el propio
-- worker con la service role key). Antes el bucket era público de lectura
-- para cualquiera con el link; este cambio es intencional (requisito de
-- seguridad) y seguro ahora porque no hay video real ya publicado.
update storage.buckets set public = false where id = 'videos';

drop policy if exists "Public read access to generated videos" on storage.objects;
