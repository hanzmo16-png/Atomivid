-- Podcast 3.0 (estudio: modos A/B/C). PROPUESTA — NO APLICADA. Aditiva: dos tablas nuevas; no toca podcast_episodes
-- ni sus filas (los episodios existentes quedan intactos). Lectura solo del dueño (RLS); toda escritura vía servidor.
create table if not exists public.podcast_studio_episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  mode text not null check (mode in ('narracion','avatar','dialogo')),
  spec jsonb not null check (jsonb_typeof(spec) = 'object' and spec->>'version' = 'podcast-studio/3'),
  status text not null default 'draft' check (status in ('draft','authorized','generating','ready','failed')),
  estimate jsonb,
  estimated_usd numeric(12,4) check (estimated_usd is null or estimated_usd >= 0),
  authorized_usd numeric(12,4) check (authorized_usd is null or authorized_usd >= 0),
  authorized_at timestamptz,
  run_token uuid,
  run_started_at timestamptz,
  progress jsonb,
  result jsonb,
  video_path text,
  audio_path text,
  cost_usd numeric(12,4),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists podcast_studio_episodes_user_created on public.podcast_studio_episodes (user_id, created_at desc);
alter table public.podcast_studio_episodes enable row level security;
drop policy if exists podcast_studio_episodes_owner_read on public.podcast_studio_episodes;
create policy podcast_studio_episodes_owner_read on public.podcast_studio_episodes for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.podcast_studio_episodes from anon, authenticated;

-- Libro de operaciones de pago del estudio: una fila por clave de idempotencia (dedupe, reintentos sin doble cobro).
create table if not exists public.podcast_studio_operations (
  key text primary key check (key ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  episode_id uuid not null references public.podcast_studio_episodes(id) on delete cascade,
  provider text not null,
  op text not null,
  state text not null check (state in ('reserved','settled','released','uncertain')),
  reserved_usd numeric(12,4) not null check (reserved_usd >= 0),
  actual_usd numeric(12,4) check (actual_usd is null or actual_usd >= 0),
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists podcast_studio_operations_episode on public.podcast_studio_operations (episode_id);
alter table public.podcast_studio_operations enable row level security;
drop policy if exists podcast_studio_operations_owner_read on public.podcast_studio_operations;
create policy podcast_studio_operations_owner_read on public.podcast_studio_operations for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.podcast_studio_operations from anon, authenticated;
