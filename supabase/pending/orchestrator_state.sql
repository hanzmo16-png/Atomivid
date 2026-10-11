-- PENDING (not in supabase/migrations/, so the apply workflow never runs it). Needs Hans's approval.
-- Durable store for the agents' orchestrator: its own schema, one JSON row, optimistic concurrency on `revision`.
-- Separate from Atomivid's production tables and from pi_paid_operations (audiovisual spend).
create schema if not exists orchestrator;
create table if not exists orchestrator.state (
  id integer primary key check (id = 1),
  doc jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table orchestrator.state enable row level security; -- no policies: service role only
revoke all on schema orchestrator from anon, authenticated;
revoke all on orchestrator.state from anon, authenticated;
-- PostgREST must expose the schema for the service-role client: add "orchestrator" to Exposed schemas in the
-- Supabase dashboard (Settings → API) when this is approved.
