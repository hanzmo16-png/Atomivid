-- Atomivid — añade el estado "draft" a la taxonomía de estados del modo
-- avatar, para que coincida exactamente con la lista de estados pedida
-- para el producto (draft, queued, processing, completed, failed,
-- cancelled).
--
-- *** NO APLICADA TODAVÍA EN EL PROYECTO REAL DE SUPABASE ***
-- Igual que las migraciones anteriores (0009-0012): se deja preparada y
-- documentada, no se ejecuta sin autorización explícita.
--
-- Por qué existe: la migración 0011 (tampoco aplicada) definió
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
