# Durable documentary preparation

The form saves an owner-scoped job before any model request and dispatches its ID
via the existing GitHub worker connection. Closing the tab no longer holds the
research/writing response open. The dashboard displays queued, running and failed
jobs; completed jobs link to the existing production configuration. There is no
automatic media generation.

Production credentials and configured model remain in Vercel. GitHub advances
one stage per signed HTTP call, with a five-minute HMAC window and a fixed
first-party destination. Raw credentials and briefs are not sent in events or
logged. The automatic deployment probe authenticates/checks schema availability
but cannot claim jobs or call providers.

Narration and editorial review run before visual planning. Each beat receives its
own short visual response; no response must contain the entire visual breakdown.
The creative brief, seven alternative angles, clone test, literal evidence,
reviewer and single bounded editorial rewrite remain. Visual quotes must match the
approved narration. Output caps are unchanged for writer/critic; each visual plan
is limited to 4,000 tokens. This is still probabilistic generation: a truncated or
invalid response stops with a visible error and never becomes an approved script.

The existing ledger persists raw responses/usage before validation. Each worker
HTTP request admits at most one NEW provider request, before reservation; cached
stages replay for free. Duplicate worker messages are fenced by SQL and the ledger.
Uncertain submissions, failed jobs and abandoned running workers are never reset
by a timer. Only queued dispatch can be reactivated from the UI. Re-enqueueing the
same owner/input/version reopens the same job, including failed jobs.

Script and media worker admissions share the global policy lock and concurrency
count. Financial caps, manual balances, reserve, provider/clip quotas and alerts
are unchanged. Owner SELECT is the only authenticated table permission; all
mutations and RPCs are service-only. Final script insertion and job completion
are a single transaction.

## Verification

- TypeScript; 1,342 unit, 61 editorial and 76 spending tests pass (overlapping suites).
- Real SDK serialization with synthetic responses exercises narration, critic,
  five separate visual calls and final approval; no compiled grammar is sent.
- Memory-ledger tests interrupt between paid stages, resume without duplicate
  charges, and refuse uncertain submissions.
- Rendered history-card tests cover running, failed, stalled and completed states.
- Transactional database probes validate duplicate claims, two-worker admission,
  rejection of unapproved completion, RLS isolation and service-only mutations.
  All fixture rows are rolled back; no provider is contacted.
- Deployment probe verifies GitHub-to-production authentication and database
  availability without generation. Its result must be checked after deployment.

Remaining limits: provider writing quality/output length still require a real
user generation to validate. A killed server/runner leaves a visible job requiring
review; it does not silently release uncertain work or repeat paid calls. If the
initial dispatch fails, the saved queued job exposes a reactivation action.
