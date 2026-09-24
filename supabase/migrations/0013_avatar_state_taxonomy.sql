-- Atomivid — añade el estado "draft" a la taxonomía de estados del modo
-- avatar, para que coincida exactamente con la lista de estados pedida
-- para el producto (draft, queued, processing, completed, failed,
-- cancelled).
--
-- *** APLICADA EN EL PROYECTO REAL DE SUPABASE *** (confirmado vía
-- apply-supabase-migration.yml, ejecución autoritativa contra
-- information_schema/pg_catalog el 2026-09-17: "0001-0013 completamente
-- aplicadas"; verificado de nuevo el 2026-09-24). Este comentario decía
-- "NO APLICADA" hasta esta corrección — quedó desactualizado tras la
-- aplicación real.
--
-- Por qué existe: la migración 0011 (también aplicada) definió
-- avatars.status con ('uploaded', 'processing', 'ready', 'failed',
-- 'deleted') y video_requests.avatar_render_status con ('queued',
-- 'processing', 'completed', 'failed', 'cancelled') — ninguna de las dos
-- incluye "draft" (una solicitud de avatar creada pero todavía no enviada
-- a generar). Se añade como valor permitido ADICIONAL en ambas — nunca se
-- quita ni se renombra ningún valor existente, así que ninguna fila
-- existente puede quedar en un estado que ya no sea válido.
--
-- Idempotente: `drop constraint if exists` + `add constraint` (mismo
-- patrón ya usado en 0011) — aplicarla dos veces no falla ni duplica nada.
--
-- ROLLBACK (seguro — solo restringe el CHECK, no toca datos; solo
-- ejecutar si ninguna fila quedó en 'draft', si no, migrar esas filas a
-- otro estado primero):
--   alter table public.avatars drop constraint if exists avatars_status_check;
--   alter table public.avatars add constraint avatars_status_check
--     check (status in ('uploaded', 'processing', 'ready', 'failed', 'deleted'));
--   alter table public.video_requests drop constraint if exists video_requests_avatar_render_status_check;
--   alter table public.video_requests add constraint video_requests_avatar_render_status_check
--     check (avatar_render_status is null or avatar_render_status in
--       ('queued', 'processing', 'completed', 'failed', 'cancelled'));

alter table public.avatars
  drop constraint if exists avatars_status_check;
alter table public.avatars
  add constraint avatars_status_check
  check (status in ('draft', 'uploaded', 'processing', 'ready', 'failed', 'deleted'));

alter table public.video_requests
  drop constraint if exists video_requests_avatar_render_status_check;
alter table public.video_requests
  add constraint video_requests_avatar_render_status_check
  check (avatar_render_status is null or avatar_render_status in
    ('draft', 'queued', 'processing', 'completed', 'failed', 'cancelled'));
