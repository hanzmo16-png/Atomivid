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

-- Cierre audiovisual (grok/podcast-audiovisual-cierre): tope de gasto del estudio aplicado EN LA BASE, no solo en la app.
-- El estudio usa su propio libro (no pi_paid_operations), así que pi_spend_authorizations (PR #198) no lo cubre. Toda
-- RESERVA nueva (antes de llamar al proveedor) se admite solo si el episodio es del mismo dueño, está autorizado o
-- generándose, y reservado+liquidado+incierto (sin esta clave) + esta reserva ≤ min(authorized_usd, 50). La fila del
-- episodio se bloquea FOR UPDATE: dos reservas concurrentes no pueden pasar el mismo saldo. Sin reserva no hay llamada.
alter table public.podcast_studio_episodes drop constraint if exists podcast_studio_episodes_authorized_max;
alter table public.podcast_studio_episodes add constraint podcast_studio_episodes_authorized_max check (authorized_usd is null or authorized_usd <= 50);
create or replace function public.podcast_studio_operations_cap() returns trigger language plpgsql security definer set search_path = '' as $$
declare e public.podcast_studio_episodes%rowtype; used numeric;
begin
  if new.state <> 'reserved' then return new; end if;
  if tg_op = 'UPDATE' and old.state = 'reserved' and old.reserved_usd >= new.reserved_usd then return new; end if;
  select * into e from public.podcast_studio_episodes where id = new.episode_id for update;
  if not found then raise exception 'STUDIO_CAP: episode missing'; end if;
  if e.user_id <> new.user_id then raise exception 'STUDIO_CAP: owner mismatch'; end if;
  if e.status not in ('authorized','generating') or e.authorized_usd is null then raise exception 'STUDIO_CAP: episode not authorized'; end if;
  select coalesce(sum(case when o.state = 'settled' then coalesce(o.actual_usd, o.reserved_usd) when o.state in ('reserved','uncertain') then o.reserved_usd else 0 end), 0)
    into used from public.podcast_studio_operations o where o.episode_id = new.episode_id and o.key <> new.key;
  if used + new.reserved_usd > least(e.authorized_usd, 50) + 0.00001 then
    raise exception 'STUDIO_CAP: authorization exceeded (used %, requested %, cap %)', used, new.reserved_usd, least(e.authorized_usd, 50); end if;
  return new;
end $$;
revoke all on function public.podcast_studio_operations_cap() from public, anon, authenticated;
drop trigger if exists podcast_studio_operations_cap on public.podcast_studio_operations;
create trigger podcast_studio_operations_cap before insert or update on public.podcast_studio_operations for each row execute function public.podcast_studio_operations_cap();
