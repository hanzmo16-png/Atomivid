-- Atomivid — desglose adicional del planificador visual (imagen generada
-- vs. stock) en generation_costs.
--
-- *** NO APLICADA TODAVÍA EN EL PROYECTO REAL DE SUPABASE ***
-- Igual que las migraciones anteriores (0009-0011): se deja preparada y
-- documentada, no se ejecuta sin autorización explícita — pegar en el SQL
-- Editor de Supabase cuando se autorice.
--
-- Por qué existe: la migración 0010 (tampoco aplicada) ya agregó
-- image_provider/image_generation_count/image_cost_usd a generation_costs,
-- pero solo alcanza para "cuántas imágenes se generaron realmente". El
-- planificador visual (src/lib/video/visual-resource-planner.ts +
-- visual-resource-resolver.ts) distingue TRES cosas distintas por
-- solicitud: cuántas escenas se CONSIDERARON candidatas a generación
-- (image_requested_count), cuántas de esas terminaron reutilizando un
-- archivo ya generado en un intento anterior por idempotencia
-- (image_reused_count, nunca facturado de nuevo), y cuántas fueron
-- llamadas nuevas de verdad (la ya existente image_generation_count) —
-- necesarias las tres para auditar el costo real sin ambigüedad.
--
-- Idempotente: `add column if not exists` en cada columna — aplicarla dos
-- veces, o sobre un esquema que ya la tenga, no falla ni duplica nada. No
-- borra ni modifica ninguna columna existente — preserva todos los datos.
--
-- ROLLBACK (seguro, no borra imágenes ya subidas a Storage):
--   alter table public.generation_costs
--     drop column if exists image_requested_count,
--     drop column if exists image_reused_count,
--     drop column if exists image_dry_run,
--     drop column if exists image_model,
--     drop column if exists image_size;

alter table public.generation_costs
  add column if not exists image_requested_count integer not null default 0;

alter table public.generation_costs
  add column if not exists image_reused_count integer not null default 0;

-- true si esta solicitud corrió el planificador en modo dry-run (nunca
-- debería ocurrir en una solicitud real que terminó en video — el modo
-- dry-run es una herramienta de línea de comandos aparte, ver
-- scripts/dry-run-visual-plan.ts — esta columna existe para poder
-- confirmarlo con una consulta en vez de solo confiar en que nunca pasó).
alter table public.generation_costs
  add column if not exists image_dry_run boolean not null default false;

-- Modelo/tamaño configurados (p. ej. "gpt-image-2"/"1024x1536") — NUNCA
-- credenciales ni nada sensible, solo metadata de configuración.
alter table public.generation_costs
  add column if not exists image_model text;

alter table public.generation_costs
  add column if not exists image_size text;
