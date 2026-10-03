-- Service-only snapshots; owner checks also run in the authenticated API/worker.
create table public.vfx_director_jobs (
  id text primary key,
  owner_id uuid not null references auth.users(id),
  revision bigint not null default 0 check (revision >= 0),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  constraint vfx_snapshot_identity check (
    snapshot->>'id' = id and snapshot->>'ownerId' = owner_id::text
    and (snapshot->>'revision')::bigint = revision
  )
);
alter table public.vfx_director_jobs enable row level security;
revoke all on public.vfx_director_jobs from anon, authenticated;
grant select, insert, update on public.vfx_director_jobs to service_role;
