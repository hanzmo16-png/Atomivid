-- 0022 — «Texto a voz» para podcast: episodios largos (piloto) y música
-- opcional. Nueva y aditiva: 0021 ya está aplicada y no se reescribe.
--
-- 1) Capacidad técnica del guion: 20.000 → 60.000 caracteres. Solo AMPLÍA
--    el CHECK existente (ninguna fila actual deja de cumplirlo). Es
--    capacidad técnica, no una cuota: los límites por usuario los pone el
--    servidor (max_chars_per_piece, max_chars_per_month).
-- 2) Límite por pieza vigente al crear, guardado y comprobado por la base.
-- 3) Piloto de episodios largos: como máximo UNA pieza larga en cola o en
--    proceso en toda la cuenta (índice único parcial), para no consumir en
--    paralelo la cuota compartida del proveedor.
-- 4) Música: elección, pista usada y estado propio de la mezcla. La
--    narración (audio_path) y la mezcla (mix_path) son archivos distintos:
--    si la mezcla falla, la narración se conserva.
--
-- Requisito: 0021 aplicada. No toca datos existentes.
--
-- ROLLBACK (ejecutar solo si ninguna pieza usa ya los campos nuevos):
--   drop index if exists public.tts_jobs_one_active_long_pilot;
--   alter table public.tts_jobs drop constraint if exists tts_jobs_characters_within_piece_limit;
--   alter table public.tts_jobs drop constraint if exists tts_jobs_mix_status_check;
--   alter table public.tts_jobs drop constraint if exists tts_jobs_music_choice_check;
--   (y quitar las columnas nuevas; el CHECK del guion puede volver a 20000
--    solo si ninguna fila lo supera)

do $$
declare
  c record;
begin
  -- El CHECK de 0021 es anónimo (Postgres lo nombra tts_jobs_script_check);
  -- se buscan por definición para no dejar el límite viejo vivo si tuviera otro nombre.
  for c in
    select conname from pg_constraint
    where conrelid = 'public.tts_jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%char_length(script)%'
  loop
    execute format('alter table public.tts_jobs drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.tts_jobs
  add constraint tts_jobs_script_check check (char_length(script) between 1 and 60000);

alter table public.tts_jobs
  add column if not exists max_chars_per_piece integer,
  add column if not exists long_pilot boolean not null default false,
  add column if not exists music_choice text not null default 'none',
  add column if not exists music_track_id text,
  add column if not exists mix_status text,
  add column if not exists mix_path text,
  add column if not exists mix_duration_seconds numeric,
  add column if not exists mix_error text,
  add column if not exists mix_attempts integer not null default 0,
  add column if not exists narration_loudness jsonb,
  add column if not exists mix_loudness jsonb;

alter table public.tts_jobs
  add constraint tts_jobs_music_choice_check check (music_choice in ('none', 'suspense', 'documentary'));
alter table public.tts_jobs
  add constraint tts_jobs_mix_status_check check (mix_status is null or mix_status in ('pending', 'processing', 'completed', 'failed'));
alter table public.tts_jobs
  add constraint tts_jobs_characters_within_piece_limit check (max_chars_per_piece is null or characters <= max_chars_per_piece);

create unique index if not exists tts_jobs_one_active_long_pilot
  on public.tts_jobs ((true))
  where long_pilot and status in ('queued', 'processing');
