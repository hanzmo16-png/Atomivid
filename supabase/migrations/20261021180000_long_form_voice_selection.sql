-- Voz de narración elegida para Long Form (p. ej. un clon privado concedido como «El Duro»).
-- Reutiliza la columna reel_voice_id (20261020200444). Aditiva: NULL conserva la voz predeterminada de todo lo existente.
-- Un Reel la elige al crear (insert). Un Long Form la recibe UNA vez, del servidor, en el MISMO UPDATE condicional que
-- confirma el plan (confirm-production.ts) y es inmutable después. Sin tablas nuevas ni cambios de permisos.
set local lock_timeout = '3s';

-- 20261020200444 was applied to production outside the migration tool (2026-10-21 run 39633746212: the column already
-- existed, registration missing), so its objects are not assumed: the constraint and trigger are (re)created here.
alter table public.video_requests drop constraint if exists video_requests_reel_voice_id_valid;
alter table public.video_requests add constraint video_requests_reel_voice_id_valid
  check (reel_voice_id is null or (mode in ('visual', 'long_form') and reel_voice_id ~ '^[A-Za-z0-9]{8,64}$'));

comment on column public.video_requests.reel_voice_id is
  'Server-validated narration voice. Reel: chosen at creation. Long Form: set once with the plan confirmation. Null = legacy language default. Immutable afterwards.';

create or replace function public.reel_voice_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.reel_voice_id is distinct from old.reel_voice_id then
    -- Única transición permitida: un Long Form sin voz recibe una en el mismo UPDATE que confirma su plan.
    if not (old.mode = 'long_form' and old.long_form_confirmed_at is null and new.long_form_confirmed_at is not null
            and old.reel_voice_id is null) then
      raise exception 'reel voice is immutable';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.reel_voice_immutable() from public, anon, authenticated;
create or replace trigger reel_voice_immutable before update on public.video_requests
for each row execute function public.reel_voice_immutable();
