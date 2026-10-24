-- OPS (NOT a migration; nothing applies this automatically). Requires the owner's explicit authorization.
-- Why: production keeps two migration registries. scripts/apply-supabase-migration.ts only reads
-- public._migrations_applied (and reconciles against the real schema only for 0001–0019), so the timestamped
-- migrations below — applied and recorded ONLY in supabase_migrations.schema_migrations — would be EXECUTED AGAIN by
-- "apply all pending". Each file below was verified present in the production schema by
-- scripts/qa/schema-readonly (claude/schema-readonly-pr200, run 40132895580 attempt 2: objects n/n, or no detectable
-- objects but registered in schema_migrations). This only records names; it runs no migration SQL.
-- 20261024000000_spend_authorizations.sql is recorded too: its 5 objects are present in production (marker t).
begin;
insert into public._migrations_applied(name) values
  ('20261005143935_provider_supply_controls.sql'),
  ('20261005145807_provider_supply_settlement_clock.sql'),
  ('20261005150229_provider_supply_job_reservations.sql'),
  ('20261005152850_provider_supply_worker_slots.sql'),
  ('20261006021611_manual_balance_freshness_30_minutes.sql'),
  ('20261006052212_completed_visual_review_concurrency.sql'),
  ('20261006135845_manual_balance_no_expiry.sql'),
  ('20261006180218_durable_documentary_script_jobs.sql'),
  ('20261007003313_documentary_editorial_checkpoint.sql'),
  ('20261009040743_server_owned_generation_writes.sql'),
  ('20261011040000_pilot_run_budget.sql'),
  ('20261013173826_failed_script_concurrency_slot.sql'),
  ('20261014183400_finished_podcast_image_slot.sql'),
  ('20261017140000_director_requested.sql'),
  ('20261019103000_avatar_source_claim_unique.sql'),
  ('20261020150535_reel_provider_spend_cap.sql'),
  ('20261020200444_reel_voice_selection.sql'),
  ('20261024000000_spend_authorizations.sql')
on conflict (name) do nothing;
-- expected afterwards: every file in supabase/migrations is in public._migrations_applied
commit;
