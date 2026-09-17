-- Prueba reproducible de aislamiento RLS + idempotencia para las tablas
-- de la migración 0011 (avatars, video_requests) — ver
-- supabase/migrations/verify/README.md para cómo correrla.
\set ON_ERROR_STOP on

grant select, insert on public.avatars, public.video_requests to authenticated;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@test.local');

-- User A crea un avatar y una solicitud.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

insert into public.avatars (user_id, name, provider, consent_given, consent_given_at, consent_policy_version)
values ('11111111-1111-1111-1111-111111111111', 'Avatar de A', 'heygen', true, now(), 'v1');

insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('11111111-1111-1111-1111-111111111111', 'tema de A', 'Motivacional', 30, 'visual');

reset role;

-- User B intenta ver avatares/solicitudes — debe ver CERO filas de A.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select count(*) as avatars_visibles_para_b from public.avatars;
select count(*) as video_requests_visibles_para_b from public.video_requests;

-- User B intenta insertar un avatar SUPLANTANDO a User A (user_id de A) —
-- debe fallar por la policy "with check (auth.uid() = user_id)".
do $$
begin
  begin
    insert into public.avatars (user_id, name, provider, consent_given, consent_given_at, consent_policy_version)
    values ('11111111-1111-1111-1111-111111111111', 'avatar robado', 'heygen', true, now(), 'v1');
    raise exception 'FALLO DE SEGURIDAD: User B pudo insertar un avatar a nombre de User A';
  exception
    when insufficient_privilege or others then
      raise notice 'OK: la policy de insert bloqueó la suplantación (%: %)', sqlstate, sqlerrm;
  end;
end $$;

reset role;

-- Como el dueño (service role / superusuario, que se salta RLS), confirma
-- que las filas de A SÍ existen (no se perdieron, solo estaban ocultas).
select count(*) as avatars_totales_reales from public.avatars;
select count(*) as video_requests_totales_reales from public.video_requests;

-- Verifica el índice único de idempotencia: dos solicitudes con la MISMA
-- idempotency_key deben ser rechazadas.
insert into public.video_requests (user_id, topic, style, duration_seconds, mode, idempotency_key)
values ('11111111-1111-1111-1111-111111111111', 'tema idempotente', 'Motivacional', 30, 'visual', 'idem-key-test-1');

do $$
begin
  begin
    insert into public.video_requests (user_id, topic, style, duration_seconds, mode, idempotency_key)
    values ('11111111-1111-1111-1111-111111111111', 'tema idempotente duplicado', 'Motivacional', 30, 'visual', 'idem-key-test-1');
    raise exception 'FALLO: se permitió una idempotency_key duplicada';
  exception
    when unique_violation then
      raise notice 'OK: el índice único de idempotencia rechazó la clave duplicada';
  end;
end $$;

-- NULL debe seguir siendo válido múltiples veces (índice parcial "where idempotency_key is not null").
insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('11111111-1111-1111-1111-111111111111', 'sin idempotency key 1', 'Motivacional', 30, 'visual');
insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('11111111-1111-1111-1111-111111111111', 'sin idempotency key 2', 'Motivacional', 30, 'visual');
select 'OK: multiples NULL en idempotency_key permitidos' as resultado;
