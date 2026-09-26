-- Atomivid — Catálogo de voces, «Texto a voz» y «Mi voz».
--
-- NO APLICADA automáticamente. Aplicar con el workflow existente
-- apply-supabase-migration.yml ANTES de encender VOICE_CATALOG_ENABLED,
-- TEXT_TO_SPEECH_ENABLED o MY_VOICE_ENABLED (todas apagadas por defecto).
-- Todo es aditivo: una columna nullable y dos tablas nuevas.
--
-- 1) video_requests.voice_choice (text, nullable): «mateo», «miguel»… o
--    «custom:<uuid>» (voz privada propia). NULL = voz por defecto de
--    siempre (Mateo): todas las filas existentes siguen igual.
--
-- 2) user_voices: voces privadas clonadas por el usuario. Solo la
--    propietaria puede leerlas (RLS). Escrituras solo desde el servidor
--    (cliente de servicio) tras comprobar la sesión: crear, clonar, probar y
--    eliminar pasan por rutas que verifican la propiedad.
--
-- 3) tts_jobs: piezas de «Texto a voz» (un narrador por pieza). Solo la
--    propietaria puede leerlas. client_request_id único por usuario evita
--    un doble envío (mismo formulario enviado dos veces = la misma pieza).
--
-- ROLLBACK (seguro — nada existente depende de esto):
--   drop table if exists public.tts_jobs;
--   drop table if exists public.user_voices;
--   alter table public.video_requests drop column if exists voice_choice;

alter table public.video_requests
  add column if not exists voice_choice text;

create table if not exists public.user_voices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Doble envío del formulario = la misma voz (único por usuaria).
  client_request_id uuid not null,
  name text not null check (char_length(name) between 1 and 40),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'cloning', 'testing', 'ready', 'failed', 'deleting', 'deleted')),
  provider text not null default 'elevenlabs',
  provider_voice_id text,
  -- Muestra original en Storage (bucket privado «videos», carpeta del usuario).
  -- Se borra al clonar salvo que el usuario pida conservarla (keep_sample).
  sample_path text,
  sample_seconds numeric,
  sample_bytes integer,
  keep_sample boolean not null default false,
  consent_version text not null,
  consent_at timestamptz not null,
  test_audio_path text,
  error_message text,
  attempts integer not null default 0,
  -- true = la llamada de clonación pudo completarse sin confirmación
  -- (timeout, respuesta rota): no se reintenta sola; se revisa a mano.
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, client_request_id)
);

create unique index if not exists user_voices_provider_voice_id_key
  on public.user_voices (provider_voice_id) where provider_voice_id is not null;
create index if not exists user_voices_user_created_idx
  on public.user_voices (user_id, created_at desc);

alter table public.user_voices enable row level security;
create policy "Users can view their own voices"
  on public.user_voices for select
  using (auth.uid() = user_id);

create table if not exists public.tts_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  title text not null check (char_length(title) between 1 and 120),
  language text not null check (language in ('es', 'en')),
  voice_choice text not null,
  voice_label text not null,
  script text not null check (char_length(script) between 1 and 20000),
  characters integer not null,
  segments_total integer,
  segments_done integer not null default 0,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  audio_path text,
  duration_seconds numeric,
  estimated_seconds numeric,
  estimated_usd numeric,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, client_request_id)
);

create index if not exists tts_jobs_user_created_idx
  on public.tts_jobs (user_id, created_at desc);

alter table public.tts_jobs enable row level security;
create policy "Users can view their own text-to-speech jobs"
  on public.tts_jobs for select
  using (auth.uid() = user_id);
