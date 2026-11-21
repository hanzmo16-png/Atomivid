# Event Orchestrator V1 — isolated offline prototype

**Not deployed. Not wired to real GitHub or Google Drive webhooks. Not an agent.**
This is a fail-closed, standard-library-only reference implementation independent from `src/lib/orchestrator`. It does not alter `AGENTS.md`, production, database schema, secrets, existing jobs, approvals, or the audiovisual ledger.

## Run
```sh
cd tools/event-orchestrator-v1
python3 -m unittest -v test_coordinator.py
```

## Architecture
GitHub event → authenticated ingress (future; NOT IMPLEMENTED) → `receive()` with verified HMAC `X-Hub-Signature-256`, delivery id, event type → SQLite audit and dedup → human review queue.

Existing known task-to-owner mappings must be seeded by a separately authorized operator. External payloads do NOT assign ownership. Kill switch defaults ON. A matched PR SHA is tagged REVIEW_REQUIRED, never automatically APPROVED. CI events are observed without claims of deployment or user access. An explicit `claim()` operation uses a transaction and owner lease with a maximum three claims. No webhook calls it.

States reserved by schema: PENDING, RUNNING, DELIVERED, VERIFIED, APPROVED, BLOCKED. **This prototype does not implement automated transitions to DELIVERED/VERIFIED/APPROVED**; those require an authenticated human or later policy implementation. `authorization_scope` is stored but never interpreted as permission to spend or deploy.

## Security caveats and activation gates
- Only an HMAC-verified payload can enter `receive()`; a real receiver still needs body-size caps, robust JSON shape validation, source/API authentication, rate limits, TLS, and secret management.
- Digest and delivery ID deduplication reject duplicate and conflicting replays in persistent SQLite. No authenticated event timestamp is part of GitHub's signing contract, so **a previously unseen valid signed payload cannot be proven fresh** by this code. Retain IDs/digests according to a documented policy; do not claim cryptographic freshness.
- SQLite persistence requires a persistent volume and single-writer discipline. Never put a writable SQLite file on ephemeral Vercel filesystem. For deployment evaluate Supabase or managed queue *with a separately reviewed migration*.
- GitHub `pull_request`, `check_suite`, `workflow_run`, `repository_dispatch` should be subscribed with least privilege; note `repository_dispatch` is caller-controlled and its contents are untrusted assertions.
- GitHub Actions event delivery is not an agent completion guarantee. Event-to-task mapping, explicit ACK, staged CI, and manual acceptance are separate.
- GitHub `workflow_run` may have privilege differences versus untrusted PR code; never checkout/run submitted code with deployment secrets.
- Drive changes: use Google Drive changes.watch plus changes.list (webhook = hint, not file identity), persist page tokens, renew expiring channels, periodically reconcile missed notifications. Not implemented here.
- Prior Drive protocol forbids automated solicitation and assumes all agents write under one owner identity, so Drive claims never authorize work, spending, merges, or production.
- USD 0 additional spend: pure Python tests; no API calls or provider usage.

## Rollout
1. Independent review of tests and semantics on this draft, without touching existing orchestrator.
2. Add an authenticated HTTP adapter and disposable persistent storage with explicit owner-approved infrastructure. Expand tests for payload limits, two workers and process crashes.
3. Test GitHub webhook deliveries in a staging-only repository; implement replay auditing, reconcile lost events and Drive channel renewals.
4. Require separately authorized activation. AI reviewers and autonomous execution are explicitly **out of scope for V1**.

## Future
V2: paid-model audit only behind budget authorization, structured and inspectable review; V3: authorized code agent through explicit task ownership, limited concurrency, and strict gates. Neither is implemented.

## Relation to active delivery priorities
Keep Claude on Podcast Studio and Grok on Long Form/Recraft and ATLAS. This draft does not change their assigned work. No automatic requests published.
