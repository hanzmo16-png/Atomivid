-- Atomivid — progreso por etapas durante el render.
-- Mientras status = 'processing', progress_stage indica en qué parte del
-- pipeline va (voz, footage, música, subtítulos, render, subiendo), para
-- mostrarlo en el historial en vez de un solo "Generando" genérico.

alter table public.video_requests
  add column if not exists progress_stage text;
