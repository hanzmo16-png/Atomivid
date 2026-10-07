-- Persisted outcome classification for documentary preparation. Additive only.
-- technical   = format/transport/reference/persistence failure (owner may retry; saved paid work replays free)
-- editorial   = the critic's objection to a complete, valid draft (owner may request a bounded correction)
-- interrupted = a worker invocation died without confirming its last provider request
alter table public.documentary_script_jobs
 add column if not exists failure_kind text check (failure_kind in ('technical','editorial','interrupted')),
 add column if not exists error_code text check (error_code ~ '^[0-9a-f]{8}$'),
 add column if not exists retry_count integer not null default 0 check (retry_count between 0 and 3),
 add column if not exists editorial_rounds integer not null default 0 check (editorial_rounds between 0 and 2),
 add column if not exists resubmit_allowance integer not null default 0 check (resubmit_allowance between 0 and 2);
comment on column public.documentary_script_jobs.resubmit_allowance is
 'Owner-authorized re-submissions of a provider request whose outcome was never received (interrupted worker).';
