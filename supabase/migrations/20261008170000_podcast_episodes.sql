-- Minimal podcast (audio only): one row per episode. The script is private (owner-only read via RLS);
-- every write goes through the server (service role). Paid narration runs through the existing
-- paid-call ledger (pi_paid_operations, project_id = 'podcast-' || id) and supply admission.
create table if not exists public.podcast_episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  language text not null default 'es' check (language in ('es','en')),
  source text not null check (source in ('tts','upload')),
  script text check (script is null or length(script) <= 30000),
  voice_id text,
  voice_name text,
  characters integer not null default 0 check (characters >= 0),
  estimated_usd numeric(12,4) not null default 0 check (estimated_usd >= 0),
  status text not null default 'draft' check (status in ('draft','generating','ready','failed')),
  run_token uuid,
  run_started_at timestamptz,
  audio_path text,
  audio_mime text,
  duration_seconds numeric,
  audio_sha256 text,
  audio_bytes bigint,
  loudness jsonb,
  cost_usd numeric(12,4),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source = 'upload' or (script is not null and voice_id is not null))
);
create index if not exists podcast_episodes_user_created on public.podcast_episodes (user_id, created_at desc);
alter table public.podcast_episodes enable row level security;
drop policy if exists podcast_episodes_owner_read on public.podcast_episodes;
create policy podcast_episodes_owner_read on public.podcast_episodes for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.podcast_episodes from anon, authenticated;
