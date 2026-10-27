-- Rollback of A: removes exactly the 18 names A inserted (A refuses to run if any was already there).
begin;
delete from public._migrations_applied where name = any(array[
  '20261005143935_provider_supply_controls.sql',
  '20261005145807_provider_supply_settlement_clock.sql',
  '20261005150229_provider_supply_job_reservations.sql',
  '20261005152850_provider_supply_worker_slots.sql',
  '20261006021611_manual_balance_freshness_30_minutes.sql',
  '20261006052212_completed_visual_review_concurrency.sql',
  '20261006135845_manual_balance_no_expiry.sql',
  '20261006180218_durable_documentary_script_jobs.sql',
  '20261007003313_documentary_editorial_checkpoint.sql',
  '20261009040743_server_owned_generation_writes.sql',
  '20261011040000_pilot_run_budget.sql',
  '20261013173826_failed_script_concurrency_slot.sql',
  '20261014183400_finished_podcast_image_slot.sql',
  '20261017140000_director_requested.sql',
  '20261019103000_avatar_source_claim_unique.sql',
  '20261020150535_reel_provider_spend_cap.sql',
  '20261020200444_reel_voice_selection.sql',
  '20261024000000_spend_authorizations.sql']::text[]);
commit;
