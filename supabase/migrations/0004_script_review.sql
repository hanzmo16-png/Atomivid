-- Atomivid — editor/revisión de guion antes del render final.
-- Separa la generación en dos etapas: primero el guion (revisable y
-- editable por el usuario), después el render. Guarda el guion generado
-- para poder mostrarlo/editarlo y para reanudar un reintento fallido en
-- la etapa correcta (si ya hay guion, el reintento reanuda desde el
-- render; si no, reanuda desde la generación del guion).

alter table public.video_requests
  add column if not exists script_json jsonb;

alter table public.video_requests
  drop constraint if exists video_requests_status_check;

alter table public.video_requests
  add constraint video_requests_status_check
  check (status in ('pending', 'script_ready', 'processing', 'completed', 'failed'));
