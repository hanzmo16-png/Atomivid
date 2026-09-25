-- Atomivid — QA real (2026-09-25, "LONG FORM DB BLOCKER: duration_seconds
-- CHECK CONSTRAINT"): el intento real de Hans (documental del Canal de
-- Panamá, 3 minutos = 180s) fue rechazado por Postgres con
-- "new row for relation video_requests violates check constraint
-- video_requests_duration_seconds_check".
--
-- Causa raíz: video_requests_duration_seconds_check (migración 0007) es
-- `duration_seconds > 0 and duration_seconds <= 120` — un límite pensado
-- únicamente para Reel (ALLOWED_DURATIONS = [30, 60, 90], ver
-- src/app/dashboard/new/validation.ts) y reutilizado sin cambios por
-- Avatar (mismo selector para narrationSource="tts"; para
-- "recording"/"tts_text" la duración real medida se ha mantenido bajo 120s
-- en la práctica, ver MAX_AVATAR_DURATION_SECONDS, default 120 — ver
-- src/lib/video/feature-flags.ts). Long Form nunca tuvo un rango propio:
-- su contrato visible en la UI (src/app/dashboard/long-form/new/page.tsx,
-- MIN/MAX_DURATION_MINUTES en actions.ts) es 3-15 minutos = 180-900s, muy
-- por encima del límite legacy de Reel.
--
-- Fix: constraint por modo, no un único rango global. Preserva EXACTAMENTE
-- el rango real de hoy para todo lo que no sea 'long_form' (Reel/Avatar/
-- 'hybrid', que no tiene ningún flujo real de creación propio todavía —
-- ver quota.ts) y añade el rango real de Long Form (180-900s) sin tocar
-- el de los demás modos. No se reduce Long Form para encajarlo en el
-- límite legacy de Reel, ni se elimina la protección para los demás modos.
--
-- Aditiva y reversible, mismo patrón que 0007/0013/0016 (`drop constraint
-- if exists` + `add constraint`, mismo NOMBRE de constraint reutilizado —
-- ver migration-schema-map.ts para cómo se verifica el CONTENIDO, no solo
-- la existencia, exactamente igual que 0013/0016). No borra ni modifica
-- ninguna fila existente — todas las filas actuales (Reel/Avatar, todas
-- <=120s) siguen cumpliendo el nuevo constraint sin backfill.
--
-- ROLLBACK (seguro mientras ninguna fila long_form supere 120s):
--   alter table public.video_requests
--     drop constraint if exists video_requests_duration_seconds_check;
--   alter table public.video_requests
--     add constraint video_requests_duration_seconds_check
--     check (duration_seconds > 0 and duration_seconds <= 120);
alter table public.video_requests
  drop constraint if exists video_requests_duration_seconds_check;

alter table public.video_requests
  add constraint video_requests_duration_seconds_check
  check (
    (mode = 'long_form' and duration_seconds >= 180 and duration_seconds <= 900)
    or (mode <> 'long_form' and duration_seconds > 0 and duration_seconds <= 120)
  );
