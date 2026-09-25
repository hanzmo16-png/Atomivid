-- RC mission Avatar (2026-09-25): distingue el origen del audio de
-- narración del modo avatar. Necesario para que generation_costs (0008)
-- separe correctamente el costo real de ElevenLabs (tts) del audio
-- propio del usuario (own_audio, sin costo de síntesis para nosotros) —
-- antes de esto, pipeline.ts etiquetaba CUALQUIER recorded_audio_path
-- como "uploaded" sin distinción, perdiendo el costo real de TTS.
-- Aditiva: null en cualquier fila existente (todas sin esta distinción
-- hasta ahora, incluido el modo visual), no rompe nada.
alter table public.video_requests add column if not exists avatar_narration_source text;
alter table public.video_requests drop constraint if exists video_requests_avatar_narration_source_check;
alter table public.video_requests add constraint video_requests_avatar_narration_source_check check (
  avatar_narration_source is null or avatar_narration_source in ('own_audio', 'tts')
);
