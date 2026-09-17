-- Atomivid — modalidades de video (visual/avatar/futuro hybrid) + entidades
-- de avatar con consentimiento y trazabilidad.
--
-- *** NO APLICADA TODAVÍA EN EL PROYECTO REAL DE SUPABASE ***
-- Igual que las migraciones anteriores (0009, 0010): se deja preparada y
-- documentada, no se ejecuta sin autorización explícita — pegar en el SQL
-- Editor de Supabase cuando se autorice.
--
-- SÍ VERIFICADA localmente contra un Postgres 16 real (no solo revisada a
-- ojo): se aplicaron las 11 migraciones en orden desde una base vacía, con
-- un esquema "auth"/"storage" mínimo que imita el de Supabase (auth.uid(),
-- RLS bajo el rol "authenticated"). Encontró y corrigió un bug real: la
-- migración original no era idempotente (CREATE POLICY no admite "if not
-- exists" en Postgres — aplicarla dos veces fallaba con "policy ... already
-- exists") — arreglado con "drop policy if exists" antes de cada policy,
-- confirmado con una segunda aplicación limpia (exit 0, sin errores). Se
-- confirmó además, con dos usuarios simulados: un usuario NO puede ver ni
-- insertar avatares/video_requests de otro (política de RLS rechaza la
-- suplantación con error 42501), y el índice único de idempotency_key
-- rechaza una clave duplicada mientras sigue permitiendo múltiples NULL.
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
-- nuevas todavía — ejecutar ANTES de borrar el bucket si hay archivos
-- subidos que quieras conservar, o simplemente no borrar el bucket):
--   drop table if exists public.avatars cascade;
--   alter table public.video_requests
--     drop column if exists mode,
--     drop column if exists avatar_id,
--     drop column if exists avatar_provider_video_job_id,
--     drop column if exists avatar_render_status,
--     drop column if exists avatar_voice_id,
--     drop column if exists idempotency_key;
--   alter table public.generation_costs
--     drop column if exists avatar_provider,
--     drop column if exists avatar_cost_usd,
--     drop column if exists avatar_provider_job_id;
--   -- Opcional, solo si de verdad quieres borrar también los archivos:
--   -- delete from storage.objects where bucket_id = 'avatar-uploads';
--   -- delete from storage.buckets where id = 'avatar-uploads';

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

-- CREATE POLICY no admite "if not exists" en Postgres — se dropea primero
-- (idéntico patrón a "drop constraint if exists" + "add constraint" ya
-- usado arriba) para que aplicar esta migración dos veces no falle.
-- Verificado localmente: sin este guard, una segunda aplicación de este
-- archivo falla con "policy ... already exists".
drop policy if exists "Users can view their own avatars" on public.avatars;
create policy "Users can view their own avatars"
  on public.avatars for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own avatars" on public.avatars;
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

-- Voz elegida para ESTA solicitud (un mismo avatar puede narrar con voces
-- distintas en solicitudes distintas) — id de voz del proveedor, nunca la
-- lista completa de voces (esa se resuelve en runtime contra el proveedor).
alter table public.video_requests
  add column if not exists avatar_voice_id text;

-- --- Desglose de costo del modo avatar en generation_costs (migración 0008/0010) --
alter table public.generation_costs
  add column if not exists avatar_provider text;

alter table public.generation_costs
  add column if not exists avatar_provider_job_id text;

alter table public.generation_costs
  add column if not exists avatar_cost_usd numeric not null default 0;

-- --- Bucket privado para fotografías de avatar ---------------------------
-- Privado desde su creación (a diferencia del bucket "videos", que nació
-- público y se corrigió después en la migración 0006) — una fotografía de
-- identidad nunca debe tener una policy de lectura pública. Sin policies
-- de select/insert para anon/authenticated: todo el acceso pasa por el
-- servidor con la service role key (mismo patrón que "videos" tras 0006),
-- nunca directo desde el navegador.
insert into storage.buckets (id, name, public)
values ('avatar-uploads', 'avatar-uploads', false)
on conflict (id) do nothing;
