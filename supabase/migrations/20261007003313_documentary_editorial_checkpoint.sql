-- Private draft checkpoint inherits the existing owner SELECT policy and
-- service-role-only writes. This is not an approval or a video request.
alter table public.documentary_script_jobs add column editorial_checkpoint jsonb;
alter table public.documentary_script_jobs add constraint documentary_checkpoint_unapproved check (
 editorial_checkpoint is null or (
  jsonb_typeof(editorial_checkpoint)='object'
  and editorial_checkpoint->>'status'='unapproved'
  and editorial_checkpoint->>'version'='1'
  and jsonb_typeof(editorial_checkpoint->'script')='object'
  and octet_length(editorial_checkpoint::text)<=1048576
 ) is true
);
comment on column public.documentary_script_jobs.editorial_checkpoint is
 'Owner-private unapproved narrative checkpoint. Never used as production approval.';
