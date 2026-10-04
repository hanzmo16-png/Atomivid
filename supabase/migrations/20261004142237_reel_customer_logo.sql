-- Optional per-request logo. No public Storage access or client column grants.
alter table public.video_requests add column if not exists brand_logo_path text;
alter table public.video_requests add constraint video_requests_owned_reel_logo
  check (brand_logo_path is null or (
    coalesce(mode, 'visual') = 'visual'
    and brand_logo_path = user_id::text || '/' || id::text || '/logo.png'
  ));
-- 0031 revoked table-wide client writes. This new column stays server-owned.
revoke insert (brand_logo_path), update (brand_logo_path) on public.video_requests from anon, authenticated;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('reel-logos', 'reel-logos', false, 1048576, array['image/png'])
  on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/png'];
