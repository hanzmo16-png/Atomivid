-- OPTIONAL OPS. Registers in supabase_migrations.schema_migrations (version, name) the 33 repo files production
-- already has but that registry lacks. Only needed before ever using `supabase db push`. Refuses if any version exists.
begin;
do $$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = any(array['0001', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '20261007030000', '20261008120000', '20261008131541', '20261008170000', '20261009160000', '20261009170000', '20261010050000', '20261010060000', '20261011010000', '20261011020000', '20261011030000', '20261021090000', '20261021160000', '20261021170000', '20261021180000']::text[])) then
    raise exception 'RECONCILE B: precondition failed — a version is already registered'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values
  ('0001', 'init'),
  ('0003', 'billing'),
  ('0004', 'script_review'),
  ('0005', 'render_progress'),
  ('0006', 'render_worker'),
  ('0007', 'input_limits'),
  ('0008', 'language_and_costs'),
  ('0009', 'music_traceability'),
  ('0010', 'visual_director'),
  ('0011', 'video_modes_avatar'),
  ('0012', 'visual_resource_planner'),
  ('0013', 'avatar_state_taxonomy'),
  ('0014', 'avatar_single_attempt'),
  ('0015', 'avatar_recorded_audio'),
  ('0016', 'long_form_mode'),
  ('0017', 'avatar_narration_source'),
  ('0018', 'long_form_duration_check'),
  ('0019', 'long_form_production_plan'),
  ('20261007030000', 'documentary_job_outcomes'),
  ('20261008120000', 'documentary_recovery_budget'),
  ('20261008131541', 'documentary_recovery_resume'),
  ('20261008170000', 'podcast_episodes'),
  ('20261009160000', 'early_access_and_funnel'),
  ('20261009170000', 'reels_launch_list'),
  ('20261010050000', 'long_form_30_minutes'),
  ('20261010060000', 'podcast_video'),
  ('20261011010000', 'production_pilot'),
  ('20261011020000', 'pilot_scheduler'),
  ('20261011030000', 'pilot_retries'),
  ('20261021090000', 'reel_recraft_images'),
  ('20261021160000', 'long_form_recraft_images'),
  ('20261021170000', 'recraft_provider_account'),
  ('20261021180000', 'long_form_voice_selection');
commit;
