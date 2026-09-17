-- Atomivid — modalidades de video (visual/avatar/futuro hybrid) + entidades
-- de avatar con consentimiento y trazabilidad.
--
-- *** NO APLICADA TODAVÍA EN EL PROYECTO REAL DE SUPABASE ***
-- Igual que las migraciones anteriores (0009, 0010): se deja preparada y
-- documentada, no se ejecuta sin autorización explícita — pegar en el SQL
-- Editor de Supabase cuando se autorice.
--
-- Idempotente: `create table if not exists` / `add column if not exists` /
-- `drop constraint if exists` + `add constraint` en cada cambio — aplicarla
-- dos veces, o sobre un esquema que ya la tenga, no falla ni duplica nada.
-- No borra ni modifica ninguna columna existente — preserva todos los
-- datos. "visual" queda como valor por defecto de video_requests.mode, así
-- que todas las solicitudes existentes (todas "visual" hoy) siguen
-- funcionando exactamente igual sin backfill necesario.
--
-- ROLLBACK documentado (orden inverso, seguro si nada usa las columnas
-- nuevas todavía):
--   drop table if exists public.avatars cascade;
--   alter table public.video_requests
--     drop column if exists mode,
--     drop column if exists avatar_id,
--     drop column if exists avatar_provider_video_job_id,
--     drop column if exists avatar_render_status,
--     drop column if exists idempotency_key;
--   alter table public.generation_costs
--     drop column if exists avatar_provider,
--     drop column if exists avatar_cost_usd,
--     drop column if exists avatar_provider_job_id;

-- --- Modalidad de la solicitud ---------------------------------------
alter table public.video_requests
  add column if not exists mode text not null default 'visual';

alter table public.video_requests
  drop constraint if exists video_requests_mode_check;
alter table public.video_requests
  add constraint video_requests_mode_check
  check (mode in ('visual', 'avatar', 'hybrid'));

-- --- Idempotencia (impide cobros/generaciones duplicadas en reintentos) --
alter table public.video_requests
  add column if not exists idempotency_key text;

create unique index if not exists video_requests_idempotency_key_uidx
  on public.video_requests (idempotency_key)
  where idempotency_key is not null;

-- --- Avatares (reutilizables entre solicitudes del mismo usuario) -------
-- provider_avatar_id y provider_job_id son identificadores REMOTOS del
-- proveedor (p. ej. HeyGen) — nunca deben serializarse en ninguna
-- respuesta de API hacia el navegador (mismo principio que las URLs
-- firmadas: uso exclusivamente server-side). RLS aquí protege la FILA
-- (que un usuario no vea avatares de otro), no la columna — la capa de
-- aplicación es responsable de no incluir esos dos campos en el JSON que
-- se le devuelve al cliente.
create table if not exists public.avatars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  provider text not null,
  provider_avatar_id text,
  provider_job_id text,
  source_photo_path text,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'ready', 'failed', 'deleted')),
  error_message text,
  -- Consentimiento explícito del propietario de la fotografía — exigido
  -- como política de PRODUCTO de Atomivid independientemente de si el
  -- proveedor lo exige técnicamente para este tipo de avatar (ver
  -- docs/AVATAR_MODE.md: HeyGen no exige consentimiento vía API para
  -- avatares tipo "photo", solo para "digital twin" — Atomivid lo exige
  -- siempre, para los dos casos).
  consent_given boolean not null default false,
  consent_given_at timestamptz,
  consent_policy_version text,
  -- Retención del activo fuente (la fotografía subida)
  source_deletion_requested_at timestamptz,
  source_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists avatars_user_id_created_at_idx
  on public.avatars (user_id, created_at desc);

alter table public.avatars enable row level security;

create policy "Users can view their own avatars"
  on public.avatars for select
  using (auth.uid() = user_id);

create policy "Users can insert their own avatars"
  on public.avatars for insert
  with check (auth.uid() = user_id);

-- Sin policy de update/delete para anon/authenticated (mismo patrón que
-- video_requests) — solo el service role (servidor) actualiza estado,
-- registra consentimiento o marca eliminación.

-- --- Enlace de la solicitud con el avatar usado (modo "avatar"/"hybrid") -
alter table public.video_requests
  add column if not exists avatar_id uuid references public.avatars (id);

alter table public.video_requests
  add column if not exists avatar_provider_video_job_id text;

alter table public.video_requests
  add column if not exists avatar_render_status text;

alter table public.video_requests
  drop constraint if exists video_requests_avatar_render_status_check;
alter table public.video_requests
  add constraint video_requests_avatar_render_status_check
  check (avatar_render_status is null or avatar_render_status in
    ('queued', 'processing', 'completed', 'failed', 'cancelled'));

-- --- Desglose de costo del modo avatar en generation_costs (migración 0008/0010) --
alter table public.generation_costs
  add column if not exists avatar_provider text;

alter table public.generation_costs
  add column if not exists avatar_provider_job_id text;

alter table public.generation_costs
  add column if not exists avatar_cost_usd numeric not null default 0;
