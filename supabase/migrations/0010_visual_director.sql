-- Atomivid — columnas de la capa creativa "Visual Director" (storyboard
-- semántico + proveedores de imagen/video generado/música premium).
--
-- *** APLICADA EN EL PROYECTO REAL DE SUPABASE *** (confirmado vía
-- apply-supabase-migration.yml, ejecución autoritativa contra
-- information_schema/pg_catalog el 2026-09-17: "0001-0013 completamente
-- aplicadas"; verificado de nuevo el 2026-09-24). Este comentario decía
-- "NO APLICADA" hasta esta corrección — quedó desactualizado tras la
-- aplicación real.
--
-- Por qué existe: src/lib/video/feature-flags.ts, src/lib/video/storyboard/
-- y los nuevos proveedores (src/lib/providers/image/, .../video-gen/,
-- .../music/beatoven.ts) necesitan dos cosas que hoy no existen en el
-- esquema: (1) guardar el storyboard generado por video, para trazabilidad
-- y depuración (por qué se eligió cada recurso), y (2) desglosar el costo
-- de imagen/video generado dentro de generation_costs (migración 0008),
-- que hoy solo sabe de guion/voz/footage/render/música curada.
--
-- Idempotente: `add column if not exists` en cada columna — aplicarla dos
-- veces, o sobre un esquema que ya la tenga, no falla ni duplica nada. No
-- borra ni modifica ninguna columna existente — preserva todos los datos.

-- Storyboard generado (o simulado) para esta solicitud — null en
-- solicitudes generadas antes de esta migración o con VISUAL_DIRECTOR_ENABLED
-- apagado. Ver src/lib/video/storyboard/types.ts para el schema exacto.
alter table public.video_requests
  add column if not exists storyboard_json jsonb;

-- "claude" (Visual Director real) | "simulated" (sin llamada a IA) | null
-- (etapa no ejecutada todavía en esta solicitud).
alter table public.video_requests
  add column if not exists storyboard_source text;

-- Desglose de costo de la capa creativa nueva — 0 en todo video que no usó
-- ninguna de estas integraciones (el caso normal hoy: solo Pexels/Pixabay).
alter table public.generation_costs
  add column if not exists image_provider text;

alter table public.generation_costs
  add column if not exists image_generation_count integer not null default 0;

alter table public.generation_costs
  add column if not exists image_cost_usd numeric not null default 0;

alter table public.generation_costs
  add column if not exists premium_video_provider text;

alter table public.generation_costs
  add column if not exists premium_video_clip_count integer not null default 0;

alter table public.generation_costs
  add column if not exists premium_video_cost_usd numeric not null default 0;

-- Motivo por el que NO se usó un clip premium a pesar de estar habilitado
-- (presupuesto excedido, tope de clips alcanzado, fallo del proveedor) —
-- null cuando sí se usó o cuando la función está apagada.
alter table public.generation_costs
  add column if not exists premium_video_fallback_reason text;
