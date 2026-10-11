-- Supervised pilot: independent limit of NEW spend authorised for each production run (USD), stored with the request
-- and enforced before every paid narration chunk. Nullable: a run that cannot charge anything new needs none.
-- The app reads this column on its own, so it keeps working before this migration is applied (paid starts are then
-- refused, never allowed without a limit). Additive only.
set local lock_timeout = '3s';
alter table public.podcast_episodes
  add column if not exists run_budget_usd numeric(10,4) check (run_budget_usd is null or (run_budget_usd >= 0 and run_budget_usd <= 100));
