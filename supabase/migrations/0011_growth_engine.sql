-- ATOMIVID Growth Engine — bandeja de aprobación de contenido.
-- Preparada pero NO aplicada automáticamente al proyecto remoto.
create table if not exists public.growth_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  sequence integer not null check (sequence between 1 and 21),
  channel text not null check (channel in ('tiktok', 'instagram_reels', 'youtube_shorts')),
  pillar text not null check (pillar in ('product_proof', 'creator_education', 'build_in_public')),
  language text not null default 'es' check (language in ('es', 'en')),
  objective text not null check (objective in ('awareness', 'activation', 'conversion')),
  hook text not null check (char_length(hook) between 10 and 280),
  topic text not null check (char_length(topic) between 10 and 500),
  call_to_action text not null check (char_length(call_to_action) between 3 and 120),
  experiment_key text not null,
  scheduled_for timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start, sequence)
);

create index if not exists growth_briefs_user_schedule_idx
  on public.growth_briefs (user_id, scheduled_for desc);

alter table public.growth_briefs enable row level security;

drop policy if exists "Users can view their own growth briefs" on public.growth_briefs;
create policy "Users can view their own growth briefs"
  on public.growth_briefs for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own growth briefs" on public.growth_briefs;
create policy "Users can create their own growth briefs"
  on public.growth_briefs for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own growth briefs" on public.growth_briefs;
create policy "Users can update their own growth briefs"
  on public.growth_briefs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
