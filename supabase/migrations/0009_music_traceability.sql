-- Atomivid — trazabilidad de la pista de música usada en cada video.
--
-- *** APLICADA EN EL PROYECTO REAL DE SUPABASE *** (confirmado vía
-- apply-supabase-migration.yml, ejecución autoritativa contra
-- information_schema/pg_catalog el 2026-09-17: "0001-0013 completamente
-- aplicadas"; verificado de nuevo el 2026-09-24). Este comentario decía
-- "NO APLICADA" hasta esta corrección — quedó desactualizado tras la
-- aplicación real; no editar el resto del archivo con base en la nota
-- vieja.
--
-- Por qué existe: hoy `generation_costs.music_provider` (migración 0008)
-- solo guarda el nombre del MECANISMO de selección ("curated-library",
-- "fixture", "none") — no CUÁL pista específica sonó en ese video ni su
-- licencia exacta. Para demostrar la licencia de un video puntual si algún
-- día hace falta, conviene guardar esa metadata por solicitud, no solo a
-- nivel de catálogo en MUSIC_MANIFEST (src/lib/providers/music/manifest.ts).
--
-- Mientras tanto, la misma metadata (proveedor, trackId, título, autor,
-- licencia, tonos) ya se emite en logs estructurados
-- (`[atomivid:music] pista seleccionada ...` en src/lib/video/generate.ts)
-- cada vez que se genera un video — suficiente para depurar/auditar hoy
-- sin depender de esta migración.
--
-- Idempotente: usa `if not exists` en cada columna, así que aplicarla dos
-- veces (o sobre un esquema que ya la tenga) no falla ni duplica nada.
alter table public.generation_costs
  add column if not exists music_track_id text;

alter table public.generation_costs
  add column if not exists music_track_title text;

alter table public.generation_costs
  add column if not exists music_track_author text;

alter table public.generation_costs
  add column if not exists music_track_license text;

alter table public.generation_costs
  add column if not exists music_track_source_url text;

-- Motivo del fallback cuando el video se generó SIN música (ver
-- MusicNoMatchError/MusicProviderError/MusicDownloadError/MusicInvalidFileError
-- en src/lib/providers/music/errors.ts) — null cuando sí hubo música.
alter table public.generation_costs
  add column if not exists music_fallback_reason text;
