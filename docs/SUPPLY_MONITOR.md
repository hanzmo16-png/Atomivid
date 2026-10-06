# Atomivid provider balance monitor

Standalone hourly billing observation, independent of generation and admission controls. Intended for the default branch only after one live run is verified. GitHub Actions schedules can be delayed; this is not a real-time capacity guarantee.

## Behavior

- Reads ElevenLabs subscription balance, Runway organization credit balance and HeyGen wallet using the same GitHub secret references as the render worker.
- Writes snapshots, evidence and internal notices into the existing private Supabase supply tables.
- Emits warnings at 30% and critical notices at 15% of a verified positive baseline; zero balance is critical. Missing balances produce UNKNOWN. A healthy wallet alone never produces GREEN.
- Never generates media, refills balances, changes financial policies, sends email/webhooks or resumes jobs.
- Does not include OpenAI, Anthropic or Gemini balance readers; the captured balances for those providers remain manual and unbound to worker accounts.
- Delivery mode: panel only. The owner selected internal dashboard notices on 2026-10-05. No email or webhook integration is required for this mode.
- Owner-authorized change on 2026-10-06: manual balance observations no longer expire after 30 minutes. They are starting balances for an estimate, not live API readings. Keep their original `checked_at`; `pi_supply_state_without_jobs` deducts committed consumption since that observation and uncertain/in-flight charges, and `pi_supply_state` additionally deducts open job reservations. These deductions persist across daily/monthly spending-period rollovers. Record a new observation after a top-up or external spending; never refresh timestamps to create evidence. API observations still expire after five minutes and refresh automatically through existing observers. Spend caps, reserve, worker limits, health checks and idempotency are unchanged.
- The owner/admin Command Center reads the 20 newest private notices. It shows historical status, Cancún timestamps and suggested actions; a missing or failed read never implies sufficient balance. Page refresh reads stored notices, not provider billing APIs. It does not mark external delivery or resolve prior notices.

## Requirements

Existing GitHub secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ELEVENLABS_API_KEY, RUNWAY_API_KEY, HEYGEN_API_KEY. This script deliberately accepts only the Atomivid Supabase project URL. Secrets are never printed.

The current database tables must exist: pi_supply_policies, pi_provider_accounts, pi_capacity_snapshots, pi_supply_alerts. Provider rows and baseline units must match. The script does not enable any policy.

## Validation and activation

Run `node --test scripts/supply/observe.test.mjs`. Run the workflow manually once, then verify provider observations and private outbox records. On 2026-10-05, trial run 37369557448 initially failed before any step ran. Its second attempt succeeded and a private low-balance notice was verified in the database. Individual billing coverage remains limited to the providers listed above. Do not infer balances from fixtures or treat old notices as current capacity.

After live validation, merge this isolated change to the default branch to activate the hourly schedule at minute 17. It imports no generation/UI code from the larger provider-supply branch. Disable the workflow in GitHub to stop periodic reads. Existing render workflows are unchanged.
