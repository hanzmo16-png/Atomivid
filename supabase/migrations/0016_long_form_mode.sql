-- Atomivid — modalidad "long_form" (YouTube/documental, 16:9) para
-- video_requests, como paso previo a que el pipeline Long Form deje de
-- ser un script CLI aislado y pase a ser un job real como Reel/Avatar.
--
-- Por qué existe: video_requests.mode hoy solo admite 'visual'/'avatar'/
-- 'hybrid' (migración 0011) y el pipeline de Long Form
-- (scripts/produce-long-form-video.ts) nunca escribe en esta tabla — su
-- único estado persistido son registros JSON en Supabase Storage
-- (ver ai-video-storage.ts). Esta migración NO mueve esa lógica todavía
-- (eso es un cambio de aplicación, no de esquema) — solo prepara las
-- columnas para que pueda hacerlo de forma aditiva.
--
-- Aditiva y reversible, mismo patrón que 0011/0014/0015: `add column if
-- not exists`, `drop constraint if exists` + `add constraint`. No borra
-- ni modifica ninguna columna existente. 'visual' sigue siendo el default
-- de mode, así que ninguna solicitud existente cambia de comportamiento.
--
-- ROLLBACK (seguro si nada usa las columnas nuevas todavía):
--   alter table public.video_requests
--     drop column if exists aspect_ratio,
--     drop column if exists long_form_stage;
--   alter table public.video_requests
--     drop constraint if exists video_requests_mode_check;
--   alter table public.video_requests
--     add constraint video_requests_mode_check
--     check (mode in ('visual', 'avatar', 'hybrid'));

-- --- Modalidad "long_form" ------------------------------------------------
alter table public.video_requests
  drop constraint if exists video_requests_mode_check;
alter table public.video_requests
  add constraint video_requests_mode_check
  check (mode in ('visual', 'avatar', 'hybrid', 'long_form'));

-- --- Relación de aspecto de la solicitud ----------------------------------
-- Todo lo existente (visual/avatar) es 9:16 hoy — default explícito para
-- no requerir backfill ni cambiar el comportamiento de ninguna fila
-- existente. Long Form usará '16:9'.
alter table public.video_requests
  add column if not exists aspect_ratio text not null default '9:16';

alter table public.video_requests
  drop constraint if exists video_requests_aspect_ratio_check;
alter table public.video_requests
  add constraint video_requests_aspect_ratio_check
  check (aspect_ratio in ('9:16', '16:9'));

-- --- Progreso específico de Long Form --------------------------------------
-- Mismo patrón que progress_stage (migración 0005) para Reel/Avatar, pero
-- con su propio vocabulario de etapas (ver RENDER_STAGES en
-- src/lib/video/stages.ts para el equivalente Reel) — Long Form tiene una
-- etapa "assets"/"ai_video" que las otras modalidades no tienen. Columna
-- separada, no se reutiliza progress_stage, para no forzar un vocabulario
-- de etapas compartido entre pipelines que son genuinamente distintos.
alter table public.video_requests
  add column if not exists long_form_stage text;

alter table public.video_requests
  drop constraint if exists video_requests_long_form_stage_check;
alter table public.video_requests
  add constraint video_requests_long_form_stage_check
  check (long_form_stage is null or long_form_stage in
    ('scripting', 'storyboard', 'assets', 'ai_video', 'rendering'));
