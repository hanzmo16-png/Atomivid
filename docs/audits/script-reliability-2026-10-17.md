# Script reliability audit — 2026-10-17

## Scope and evidence

Audited short-form generation, length corrections, individual scene regeneration, validation, paid-call accounting, request persistence, and recovery behavior. Reviewed the separate documentary job/checkpoint path. This patch does not claim all script incidents share one cause. Existing generic error logs cannot reconstruct a missing provider response.

Reproductions use the installed Anthropic SDK with synthetic HTTP responses and in-memory ledger/result stores. No paid generation or production data mutation was used for this patch. Account-specific diagnostics and production records are intentionally excluded from this document.

## Findings and disposition

| Priority | Failure mode | Evidence / consequence | Disposition |
| --- | --- | --- | --- |
| P1 | Structured response parsing happens inside the paid operation | `messages.parse()` can throw on an HTTP 200 response containing truncated JSON before returning usage or stop reason. The ledger then treats a received response as uncertain and has no stored body. | Fixed for short scripts and scenes: `messages.create()` returns raw response; the paid gate saves response/usage before local JSON/Zod validation. |
| P1 | Provider timeout exceeds route lifetime | SDK default is 600 seconds; route is 60 seconds. Up to three length corrections had no shared deadline. | Mitigated: shared 40-second provider budget, zero SDK retries, no new correction when less than 5 seconds remain. Database/auth latency is outside this budget; this is not a durable execution guarantee. |
| P1 | Scene regeneration bypasses persistent script intent | A random intent could submit again despite an earlier uncertain script operation. | Fixed: use the existing request-scoped intent admission and ledger reconciliation check. This is not a full request-level lock. |
| P1 | Paid result saved but final request persistence fails | The ledger can be COMMITTED while `video_requests.script_json` is absent. A subsequent POST selects `gen-N+1`, not the prior committed operation. | Open: persist an explicit generation ID and checkpoints before payment; resume the same generation through final save. Same-key cache replay alone does not fix endpoint replay. |
| P1 | Failed full regeneration deletes the previous script | `runScriptGeneration` clears `script_json` on failure to work around the history card's render/script retry inference. | Open: version drafts and store failure stage independently; keep the prior approved script until replacement succeeds. Do not simply remove the clear without fixing UI retry routing. |
| P1 | No request-level lock across multiple paid calls | Per-operation admission prevents same-key overlap; a new POST between a committed response and its correction/final persistence can select the next generation. Different parameter hashes also produce different keys. | Open: generation-level claim with ownership token, input/version hash and compare-and-set completion. |
| P2 | Output limits and malformed/schema-invalid responses collapse into generic errors | Checking `stop_reason` after SDK parsing is too late. Empty required strings also passed the prior schema. | Fixed: typed limit, refusal, empty, JSON, schema and deadline errors; enforce field bounds; do not retry paid parsing failures automatically. |
| P2 | Scene diagnostic IDs do not correlate UI and logs | Previously generated separately by logging and message classification. Fractional scene indices were accepted. | Fixed: one ID per failure, safe error metadata, integer index validation. |
| P2 | Fixed output allowance and strict word-count corrections | 2,000 output tokens cover both narration and scene metadata. Six to ten scenes may exhaust the allowance; corrections can make up to three paid calls. | Open measurement: collect stop reason, token usage, correction count and stage latency for 30/60/90-second fixtures before changing caps or scene metadata. No token/model/cost caps changed here. |
| P2 | Auth/setup exceptions occur outside route catch | An auth-client failure can bypass the JSON error handler before generation starts. | Open: move route setup into a typed response boundary; keep authentication and ownership enforcement intact. |

## Failure matrix

| Event | Expected behavior / remaining boundary |
| --- | --- |
| Valid JSON with valid narration | Persist script only after quality checks; existing optimistic concurrency checks remain. |
| Valid response outside word target | At most three calls, subject to shared time budget and paid-call caps. |
| `max_tokens` / partial non-empty JSON | Store raw response and usage, classify output limit, stop without a paid parse retry. |
| Malformed JSON / invalid schema / empty response / refusal | Store received response first, emit a typed failure, stop. |
| Transport timeout or interrupted process | Outcome can still be uncertain; preserve reconciliation barrier. A client timeout does not establish no charge. |
| Ledger read unavailable before generation | Refuse new paid work. |
| Result storage or ledger settlement fails after response | Remains a reconciliation case; this patch cannot guarantee recovery when storage itself fails. |
| Duplicate call with the same paid-operation key | Existing claim/cache avoids another provider submission; tested with memory stores. |
| Final request save fails or an old tab saves | Existing CAS prevents false success/overwrite; request-level resume is still missing. |
| Full regeneration fails with an existing script | Current destructive draft replacement behavior remains an open finding. |
| Documentary generation | Separate job checkpoints, scoped result reuse and raw `messages.create()` path; not migrated or declared production-verified by this patch. |

## Verification

- 168 focused tests passed across script generation, quality, persistence, intent admission, supply policy, paid-call accounting and documentary script suites.
- New real-SDK mocked-response tests exercise valid generation, a length correction, scene generation, truncated non-empty JSON, schema failure, refusal and empty output.
- Ledger tests verify that received invalid responses retain usage and raw results, settle once, and replay the same operation without another provider call.
- Fake-clock tests exercise shared deadline exhaustion before another call.
- Next route type generation and TypeScript checking passed; targeted ESLint passed.
- No real provider latency/quality acceptance test, route-level concurrent scene test, production rollout or payment reconciliation is claimed.

## Release and follow-up

Land this bounded patch separately from durable recovery changes. Review schema constraints and provider timing in a preview. Complete generation-level checkpointing and non-destructive draft versioning before claiming reliable automatic recovery.

For a later explicitly budgeted acceptance run, use one new short-form request, capture its diagnostic/generation ID and stage timings, confirm stored usage and script, then trigger rendering from script review. Reconcile existing uncertain operations using provider evidence; do not clear their ledger state or submit them again merely to unblock the UI.
