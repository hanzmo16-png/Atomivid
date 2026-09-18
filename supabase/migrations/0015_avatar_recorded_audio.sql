-- Private recording selected for a request. No client-supplied URL is used.
alter table public.video_requests add column if not exists recorded_audio_path text;
alter table public.video_requests drop constraint if exists video_requests_recorded_audio_path_check;
alter table public.video_requests add constraint video_requests_recorded_audio_path_check check (
  recorded_audio_path is null or (
    mode = 'avatar' and recorded_audio_path in (
      user_id::text || '/' || id::text || '/recording.wav',
      user_id::text || '/' || id::text || '/recording.mp3',
      user_id::text || '/' || id::text || '/recording.m4a'
    )
  )
);
