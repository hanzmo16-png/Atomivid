-- Stub mínimo de los esquemas "auth"/"storage" de Supabase, para poder
-- aplicar las migraciones de Atomivid contra un Postgres local normal
-- (que no los trae) y probar RLS de verdad. Solo cubre lo que las
-- migraciones referencian — no es un reemplazo de Supabase.
create extension if not exists pgcrypto;

create schema if not exists auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$ language sql stable;

-- Simula que las policies con auth.uid() = user_id de verdad restringen
-- el rol "authenticated" (Supabase corre RLS con ese rol, no con el dueño
-- de la tabla, que se salta RLS). Los roles son de CLUSTER, no de base de
-- datos — "create role" a secas falla si ya existe de una corrida
-- anterior contra el mismo Postgres, aunque la base de datos se haya
-- recreado — por eso el guard explícito.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;
grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;

-- Stub mínimo del esquema "storage" de Supabase (solo lo que las
-- migraciones referencian: storage.buckets/storage.objects).
create schema if not exists storage;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text
);
