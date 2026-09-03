-- Atomivid — Paso 2: generación automática de contenido
-- Agrega columna para registrar errores de generación y crea el bucket de
-- Storage donde se guardan los assets (imágenes, voz) y el video final.

alter table public.video_requests
  add column if not exists error_message text;

-- Bucket público de solo lectura: los archivos se sirven por URL directa.
-- La escritura solo ocurre desde el backend con la service role key
-- (nunca se expone una policy de insert/update para el rol anon/authenticated),
-- así que el acceso público de lectura es seguro para este MVP.
insert into storage.buckets (id, name, public)
values ('videos', 'videos', true)
on conflict (id) do nothing;

create policy "Public read access to generated videos"
  on storage.objects for select
  using (bucket_id = 'videos');
