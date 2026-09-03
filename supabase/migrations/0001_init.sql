-- Atomivid — esquema inicial (Paso 1)
-- Tabla que guarda las solicitudes de generación de video.
-- La generación real (guion, voz, footage, ensamblado) se agrega en el Paso 2.

create table if not exists public.video_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  topic text not null,
  style text not null,
  duration_seconds integer not null check (duration_seconds > 0),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  video_url text,
  created_at timestamptz not null default now()
);

create index if not exists video_requests_user_id_created_at_idx
  on public.video_requests (user_id, created_at desc);

alter table public.video_requests enable row level security;

-- Cada usuario solo puede ver y crear sus propias solicitudes.
create policy "Users can view their own video requests"
  on public.video_requests for select
  using (auth.uid() = user_id);

create policy "Users can insert their own video requests"
  on public.video_requests for insert
  with check (auth.uid() = user_id);
