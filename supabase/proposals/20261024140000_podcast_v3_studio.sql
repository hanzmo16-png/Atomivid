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
-- Studio spend visible to EVERY platform cap (pi_submit_with_supply, job reservations, supply state): pi_supply_spend adds the
-- studio ledger. Same signature, invoker, search_path ''; grants unchanged (create or replace keeps the ACL).
create or replace function public.pi_supply_spend(p_provider text,p_start timestamptz) returns numeric
language sql security invoker set search_path='' as $$
 select coalesce((select sum(greatest(reserved_usd,coalesce(committed_usd,0))) from public.pi_paid_operations
 where (p_provider is null or provider=p_provider) and method<>'capacity_hold'
 and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 or (created_at>=p_start and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))),0)
 +coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations
 where (p_provider is null or provider=p_provider) and status='OPEN'),0)
 -- Podcast Studio (own ledger): open reservations/uncertain always count; settled count from p_start (actual cost).
 +coalesce((select sum(case when s.state='settled' then greatest(s.reserved_usd,coalesce(s.actual_usd,0)) else s.reserved_usd end)
 from public.podcast_studio_operations s where (p_provider is null or s.provider=p_provider)
 and (s.state in ('reserved','uncertain') or (s.state='settled' and s.created_at>=p_start))),0);
$$;


-- Concurrency and daily-call limits (ChatGPT checkpoint T-20261024-1016): activeCalls/todayCalls come from pi_paid_operations
-- only. pi_supply_state is wrapped (same signature, invoker, search_path '') so every caller — pi_submit_with_supply included —
-- also counts studio calls: in flight = 'reserved'; today = every studio row created today (each one is one provider call).
-- No row is copied into pi_paid_operations, so nothing can be charged twice.
do $$ begin
  if to_regprocedure('public.pi_supply_state_pre_studio(text)') is null then
    alter function public.pi_supply_state(text) rename to pi_supply_state_pre_studio;
  end if;
end $$;
create or replace function public.pi_studio_call_counts(p_provider text, p_day_start timestamptz, p_exclude_key text default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  -- Audit E6 (#200): a 'reserved' row untouched for longer than any studio runner can live (podcast-video.yml job
  -- timeout 200 min → 4 h) has no call in flight; it stops holding a concurrency slot. It still counts as possibly
  -- charged in every spend total (cap trigger, pi_supply_spend) until mark-failed turns it 'uncertain'.
  select jsonb_build_object('active', count(*) filter (where s.state = 'reserved' and greatest(s.created_at, s.updated_at) > clock_timestamp() - interval '4 hours'),
    'today', count(*) filter (where s.created_at >= p_day_start))
  from public.podcast_studio_operations s where s.provider = p_provider and s.key is distinct from p_exclude_key
$$;
create or replace function public.pi_supply_state(p_provider text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare state jsonb; p public.pi_supply_policies%rowtype; c jsonb;
begin
  state := public.pi_supply_state_pre_studio(p_provider);
  select * into p from public.pi_supply_policies where provider = p_provider;
  if not found or not (state ? 'activeCalls') then return state; end if;
  c := public.pi_studio_call_counts(p_provider, date_trunc('day', clock_timestamp() at time zone p.timezone) at time zone p.timezone);
  return state || jsonb_build_object('activeCalls', coalesce((state->>'activeCalls')::integer, 0) + (c->>'active')::integer,
    'todayCalls', coalesce((state->>'todayCalls')::integer, 0) + (c->>'today')::integer, 'studioActiveCalls', (c->>'active')::integer, 'studioTodayCalls', (c->>'today')::integer);
end $$;
revoke all on function public.pi_supply_state(text), public.pi_supply_state_pre_studio(text), public.pi_studio_call_counts(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.pi_supply_state(text), public.pi_supply_state_pre_studio(text), public.pi_studio_call_counts(text, timestamptz, text) to service_role;

alter table public.podcast_studio_episodes drop constraint if exists podcast_studio_episodes_authorized_max;
alter table public.podcast_studio_episodes add constraint podcast_studio_episodes_authorized_max check (authorized_usd is null or authorized_usd <= 50);
create or replace function public.podcast_studio_operations_cap() returns trigger language plpgsql security definer set search_path = '' as $$
declare e public.podcast_studio_episodes%rowtype; used numeric; prev numeric; g public.pi_supply_policies%rowtype; p public.pi_supply_policies%rowtype; st jsonb; c jsonb;
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
  -- Platform caps (audit #200 P1-2): the same daily/monthly ceilings pi_submit_with_supply applies, per provider (when the
  -- provider has a policy) and global (required, fail closed). pi_supply_spend already includes the studio ledger, minus
  -- this row's previous amount when it is being re-reserved.
  prev := case when tg_op = 'UPDATE' and old.state in ('reserved','uncertain') then old.reserved_usd else 0 end;
  select * into g from public.pi_supply_policies where provider = '__global__' for update;
  if not found or not g.enabled then raise exception 'STUDIO_CAP: global supply policy unavailable'; end if;
  if public.pi_supply_spend(null, date_trunc('day', clock_timestamp() at time zone g.timezone) at time zone g.timezone) - prev + new.reserved_usd > g.daily_cap_usd
     or public.pi_supply_spend(null, date_trunc('month', clock_timestamp() at time zone g.timezone) at time zone g.timezone) - prev + new.reserved_usd > g.monthly_cap_usd then
    raise exception 'STUDIO_CAP: global funded spend ceiling'; end if;
  select * into p from public.pi_supply_policies where provider = new.provider for update;
  if found then
    if not p.enabled then raise exception 'STUDIO_CAP: provider % disabled', new.provider; end if;
    if public.pi_supply_spend(p.provider, date_trunc('day', clock_timestamp() at time zone p.timezone) at time zone p.timezone) - prev + new.reserved_usd > p.daily_cap_usd
       or public.pi_supply_spend(p.provider, date_trunc('month', clock_timestamp() at time zone p.timezone) at time zone p.timezone) - prev + new.reserved_usd > p.monthly_cap_usd then
      raise exception 'STUDIO_CAP: provider funded spend ceiling (%)', p.provider; end if;
    -- Same concurrency / daily-call limits pi_submit_with_supply applies (platform calls + other studio calls, not this key).
    st := public.pi_supply_state_pre_studio(p.provider);
    c := public.pi_studio_call_counts(p.provider, date_trunc('day', clock_timestamp() at time zone p.timezone) at time zone p.timezone, new.key);
    if coalesce((st->>'activeCalls')::integer, 0) + (c->>'active')::integer >= p.max_concurrent then raise exception 'STUDIO_CAP: concurrency (%)', p.provider; end if;
    if coalesce((st->>'todayCalls')::integer, 0) + (c->>'today')::integer >= p.max_daily_calls then raise exception 'STUDIO_CAP: daily request quota (%)', p.provider; end if;
  end if;
  return new;
end $$;
revoke all on function public.podcast_studio_operations_cap() from public, anon, authenticated;
drop trigger if exists podcast_studio_operations_cap on public.podcast_studio_operations;
create trigger podcast_studio_operations_cap before insert or update on public.podcast_studio_operations for each row execute function public.podcast_studio_operations_cap();
