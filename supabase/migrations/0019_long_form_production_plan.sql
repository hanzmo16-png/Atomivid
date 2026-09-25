-- Atomivid — RC mission "LONG FORM RC FINAL HARDENING". Antes de esta
-- migración, Long Form no tenía NINGÚN registro persistido de qué se
-- planeaba producir (estrategia visual, mezcla de assets, costo estimado)
-- ni de que un humano lo haya confirmado explícitamente antes de gastar
-- dinero real — produce.ts calculaba todo en memoria y arrancaba
-- directamente al recibir el render, sin ningún paso 9/10 del contrato
-- (mostrar costo → confirmación explícita) descrito en la misión.
--
-- Tres columnas nuevas, todas nullable, todas aditivas:
--
-- long_form_production_plan (jsonb): snapshot INMUTABLE del ProductionPlan
--   que el usuario vio y confirmó (estrategia, mezcla de shots, costo
--   estimado) — el worker ejecuta ESTE plan, nunca recalcula otro en
--   silencio (ver sección 18 de la misión, "snapshot inmutable").
-- long_form_confirmed_at (timestamptz): cuándo se confirmó — además de
--   ser informativo, es el propio mecanismo de idempotencia atómica: el
--   UPDATE que confirma y arranca la producción solo tiene éxito si esta
--   columna seguía en NULL (ver actions.ts), así que dos confirmaciones
--   simultáneas (doble click) nunca producen dos producciones.
-- long_form_progress (jsonb): unidades de trabajo reales (etapa actual,
--   completadas/total, timestamps por etapa) para poder reconstruir el
--   progreso real tras un refresh/cierre de navegador — nunca un
--   porcentaje inventado. Se sobrescribe en cada avance, no se versiona.
--
-- No se toca Reel ni Avatar: video_requests ya es la tabla compartida
-- (mode) desde 0011, y estas 3 columnas solo las escribe/lee código con
-- mode='long_form'. No hay backfill posible ni necesario — toda fila
-- existente (incluida la solicitud real del Canal de Panamá) queda con
-- las 3 en NULL, que es exactamente su estado real: nunca hubo un plan
-- confirmado para ella bajo este nuevo modelo.
--
-- ROLLBACK (seguro — ninguna fila depende de estas columnas para nada más):
--   alter table public.video_requests
--     drop column if exists long_form_production_plan,
--     drop column if exists long_form_confirmed_at,
--     drop column if exists long_form_progress;
alter table public.video_requests
  add column if not exists long_form_production_plan jsonb,
  add column if not exists long_form_confirmed_at timestamptz,
  add column if not exists long_form_progress jsonb;
