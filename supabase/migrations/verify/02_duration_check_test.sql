-- Prueba reproducible del CHECK por modo de video_requests_duration_seconds_check
-- (migración 0018) contra un Postgres real — ver README.md para cómo
-- correrla (misma harness que 01_rls_and_idempotency_test.sql: aplica
-- TODAS las migraciones en orden sobre un Postgres 16 limpio antes de
-- este script).
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'duration-check@test.local')
on conflict (id) do nothing;

-- Long Form: 180s (3 min) y 900s (15 min) son los extremos del contrato
-- visible en la UI (MIN/MAX_DURATION_MINUTES) — deben aceptarse.
insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('33333333-3333-3333-3333-333333333333', 'long form 180s', 'Documental', 180, 'long_form');
select 'OK: long_form 180s (3 min) aceptado' as resultado;

insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('33333333-3333-3333-3333-333333333333', 'long form 900s', 'Documental', 900, 'long_form');
select 'OK: long_form 900s (15 min) aceptado' as resultado;

-- Justo por debajo/encima del rango real de Long Form: deben rechazarse.
do $$
begin
  begin
    insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
    values ('33333333-3333-3333-3333-333333333333', 'long form 179s', 'Documental', 179, 'long_form');
    raise exception 'FALLO: se permitió long_form con 179s (por debajo de 180s)';
  exception
    when check_violation then
      raise notice 'OK: long_form 179s rechazado (%: %)', sqlstate, sqlerrm;
  end;
end $$;

do $$
begin
  begin
    insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
    values ('33333333-3333-3333-3333-333333333333', 'long form 901s', 'Documental', 901, 'long_form');
    raise exception 'FALLO: se permitió long_form con 901s (por encima de 900s)';
  exception
    when check_violation then
      raise notice 'OK: long_form 901s rechazado (%: %)', sqlstate, sqlerrm;
  end;
end $$;

-- Reel (mode='visual'): el contrato real ALLOWED_DURATIONS=[30,60,90]
-- sigue aceptándose sin cambios — el CHECK no se redujo para los demás modos.
insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('33333333-3333-3333-3333-333333333333', 'reel 90s', 'Motivacional', 90, 'visual');
select 'OK: visual (Reel) 90s sigue aceptado, sin cambios' as resultado;

-- Avatar (mode='avatar'): duración real medida hasta 120s (mismo tope de
-- siempre, MAX_AVATAR_DURATION_SECONDS=120 por defecto) sigue válida.
insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('33333333-3333-3333-3333-333333333333', 'avatar 44s', 'Motivacional', 44, 'avatar');
select 'OK: avatar 44s (duración real medida) sigue aceptado, sin cambios' as resultado;

-- Reel/Avatar NUNCA deben poder usar el rango de Long Form (180-900s) —
-- el CHECK es por modo, no un rango global ampliado para todos.
do $$
begin
  begin
    insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
    values ('33333333-3333-3333-3333-333333333333', 'visual con duración de long form', 'Motivacional', 180, 'visual');
    raise exception 'FALLO: se permitió mode=visual con 180s (rango de long_form, no el suyo)';
  exception
    when check_violation then
      raise notice 'OK: visual con 180s rechazado — Reel no hereda el rango de Long Form (%: %)', sqlstate, sqlerrm;
  end;
end $$;
