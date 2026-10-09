-- Private exchange for the external podcast editor; no account gets access until assigned.
-- Adapted from user-supplied podcast-editor v0.2.0. No existing bucket/policy is changed.


-- 1) Bucket privado
insert into storage.buckets (id, name, public)
values ('podcast-editor', 'podcast-editor', false)
on conflict (id) do nothing;
-- File sizes remain subject to the existing project upload limit.

-- 2) Esquema propio (NO se expone en la Data API salvo que Hans lo decida)
create schema if not exists podcast_editor;
revoke all on schema podcast_editor from public, anon;
grant usage on schema podcast_editor to authenticated;

-- 2a) Propietarios: sólo se rellena desde el SQL Editor (rol postgres). Sin políticas => la API no
--     puede leerla ni escribirla (ni el editor ni nadie con un JWT de usuario).
create table if not exists podcast_editor.propietarios (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nota       text,
  created_at timestamptz not null default now()
);
alter table podcast_editor.propietarios enable row level security;
revoke all on podcast_editor.propietarios from public, anon, authenticated;

-- 2b) Asignaciones explícitas episodio/versión -> usuario
create table if not exists podcast_editor.asignaciones (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  episode_id  text        not null check (episode_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$'),
  version     integer     not null check (version between 1 and 999999999),
  permisos    text[]      not null default array['leer_entrada','escribir_salida','escribir_estado']
              check (cardinality(permisos) > 0
                     and permisos <@ array['leer_entrada','escribir_salida','escribir_estado','escribir_entrada']),
  expires_at  timestamptz not null,
  revoked     boolean     not null default false,
  created_by  uuid        default auth.uid(),          -- null si se crea desde el SQL Editor
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (user_id, episode_id, version),
  check (expires_at > created_at and expires_at <= created_at + interval '90 days')
);
alter table podcast_editor.asignaciones enable row level security;
revoke all on podcast_editor.asignaciones from public, anon;
grant select, insert, update on podcast_editor.asignaciones to authenticated;  -- filtrado por RLS abajo
-- (sin DELETE: se revoca con revoked = true para conservar el historial)

-- 2c) Funciones auxiliares (security definer, search_path vacío, sólo ejecutables por authenticated)
create function podcast_editor.es_propietario()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from podcast_editor.propietarios p where p.user_id = auth.uid());
$$;

create function podcast_editor.permiso_objeto(p_bucket text, p_name text, p_area text, p_permiso text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  f     text[] := storage.foldername(p_name);
  v_ver integer;
begin
  if p_bucket is distinct from 'podcast-editor' or auth.uid() is null then
    return false;
  end if;
  if coalesce(array_length(f, 1), 0) < 4 or f[1] <> 'episodios' or f[4] <> p_area then
    return false;
  end if;
  if f[2] !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$' or f[3] !~ '^v[1-9][0-9]{0,8}$'
     or p_name ~ '(^|/)\.\.?(/|$)' then
    return false;
  end if;
  v_ver := substr(f[3], 2)::integer;      -- seguro: f[3] ya validado por la expresión regular
  return exists (
    select 1
    from podcast_editor.asignaciones a
    where a.user_id    = auth.uid()
      and a.episode_id = f[2]
      and a.version    = v_ver
      and not a.revoked
      and a.expires_at > now()
      and p_permiso = any (a.permisos)
  );
end;
$$;

revoke all on function podcast_editor.es_propietario() from public, anon;
revoke all on function podcast_editor.permiso_objeto(text, text, text, text) from public, anon;
grant execute on function podcast_editor.es_propietario() to authenticated;
grant execute on function podcast_editor.permiso_objeto(text, text, text, text) to authenticated;

-- 2d) Inmutabilidad de la clave de una asignación: sólo se pueden cambiar permisos, caducidad y revocación
create function podcast_editor.asignaciones_inmutables()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.user_id <> old.user_id or new.episode_id <> old.episode_id or new.version <> old.version
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'asignaciones: user_id/episode_id/version/created_* son inmutables; crear una nueva';
  end if;
  if old.revoked and not new.revoked then
    raise exception 'asignaciones: una revocación no se deshace; crear una asignación nueva';
  end if;
  if new.revoked and not old.revoked then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;
create trigger asignaciones_inmutables before update on podcast_editor.asignaciones
for each row execute function podcast_editor.asignaciones_inmutables();

-- 2e) RLS de asignaciones: el editor ve las suyas; SÓLO el propietario inserta/actualiza

create policy "asignaciones_ver" on podcast_editor.asignaciones
for select to authenticated
using (user_id = (select auth.uid()) or (select podcast_editor.es_propietario()));

create policy "asignaciones_crear" on podcast_editor.asignaciones
for insert to authenticated
with check ((select podcast_editor.es_propietario()) and created_by = (select auth.uid()));

create policy "asignaciones_modificar" on podcast_editor.asignaciones
for update to authenticated
using ((select podcast_editor.es_propietario()))
with check ((select podcast_editor.es_propietario()));

-- 3) Políticas de storage.objects (bucket 'podcast-editor')

-- 3a) Leer entrada/ de un episodio/versión asignado y vigente
create policy "pe_v2_leer_entrada" on storage.objects
for select to authenticated
using (
  bucket_id = 'podcast-editor'
  and podcast_editor.permiso_objeto(bucket_id, name, 'entrada', 'leer_entrada')
);

-- 3b) Releer SÓLO lo que el propio usuario escribió en salida/ o estado/ (verificación + URLs firmadas).
--     Justificación: sin SELECT no se puede hacer HEAD, re-descargar para comprobar sha256 ni firmar.
--     No da acceso a objetos de otros usuarios aunque estén en la misma carpeta.
create policy "pe_v2_releer_propios" on storage.objects
for select to authenticated
using (
  bucket_id = 'podcast-editor'
  and owner_id = (select auth.uid())::text
  and (   podcast_editor.permiso_objeto(bucket_id, name, 'salida', 'escribir_salida')
       or podcast_editor.permiso_objeto(bucket_id, name, 'estado', 'escribir_estado'))
);

-- 3c) Insertar en salida/ (sólo INSERT: sin política UPDATE, un objeto existente no se puede
--     sobrescribir ni con x-upsert; el editor publica COMPLETO.json el último).
create policy "pe_v2_insertar_salida" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'podcast-editor'
  and podcast_editor.permiso_objeto(bucket_id, name, 'salida', 'escribir_salida')
);

-- 3d) Insertar en estado/ (también sólo INSERT; el editor usa nombres versionados,
--     p. ej. estado/reporte-<job_key[:12]>.json, en lugar de actualizar un fichero fijo).
create policy "pe_v2_insertar_estado" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'podcast-editor'
  and podcast_editor.permiso_objeto(bucket_id, name, 'estado', 'escribir_estado')
);

-- 3e) (Opcional) Productor/Codex con su PROPIO usuario y una asignación con 'escribir_entrada':
--     inserta en entrada/ y relee sólo lo suyo para verificar antes de escribir LISTO.json.
create policy "pe_v2_productor_insertar" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'podcast-editor'
  and podcast_editor.permiso_objeto(bucket_id, name, 'entrada', 'escribir_entrada')
);
create policy "pe_v2_productor_releer" on storage.objects
for select to authenticated
using (
  bucket_id = 'podcast-editor'
  and owner_id = (select auth.uid())::text
  and podcast_editor.permiso_objeto(bucket_id, name, 'entrada', 'escribir_entrada')
);

-- 3f) El propietario puede leer todo el bucket con su propia sesión (descargas / URLs firmadas).
create policy "pe_v2_propietario_leer" on storage.objects
for select to authenticated
using (bucket_id = 'podcast-editor' and (select podcast_editor.es_propietario()));

-- SIN políticas UPDATE ni DELETE para nadie con JWT de usuario en este bucket.
-- (El borrado de una versión fallida lo haría el propietario desde el panel de Supabase.)
