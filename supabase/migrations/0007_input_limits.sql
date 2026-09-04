-- Atomivid — límites de entrada para acotar el costo máximo por video.
--
-- `duration_seconds` alimenta directamente cuántas escenas pide el guion y
-- cuánto texto sintetiza ElevenLabs — sin tope, una solicitud manipulada
-- (saltándose el <select> del formulario, p. ej. llamando al server action
-- directamente) podría pedir una duración absurda y generar un gasto y un
-- render sin límite. `topic`/`style` alimentan el prompt de Claude, así
-- que tampoco deben ser arbitrariamente largos. Estos límites son defensa
-- en profundidad — el código ya valida lo mismo antes de llegar aquí, pero
-- la base de datos es la última línea si algo se salta esa validación.
--
-- No hay datos reales todavía, así que no hace falta backfill; el rango
-- elegido (hasta 120s) da margen sobre las duraciones que ofrece hoy la UI
-- (30/60/90s) sin dejarlo abierto.
alter table public.video_requests
  drop constraint if exists video_requests_duration_seconds_check;

alter table public.video_requests
  add constraint video_requests_duration_seconds_check
  check (duration_seconds > 0 and duration_seconds <= 120);

alter table public.video_requests
  add constraint video_requests_topic_length_check
  check (char_length(topic) <= 500);

alter table public.video_requests
  add constraint video_requests_style_length_check
  check (char_length(style) <= 100);
