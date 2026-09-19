# Caption and worker hardening

## Changes

- Caption groups respect sentence endings, including a singleton at a word-count boundary. Word timings and emphasis are preserved.
- HeyGen retries only idempotent GET requests after transient failures. Asset uploads and video creation remain single-attempt. Masked credentials fail before network access.
- Render dispatch carries its attempt number. Atomic stage acquisition admits one worker per request/attempt. Owner, status and attempt fence every progress/terminal write.
- Normal-video artifacts use per-attempt storage paths, so a stale worker cannot replace a newer file.
- Worker cleanup uses the attempt recorded locally before execution and cannot overwrite a terminal or later attempt. The render step times out before the whole job so cleanup has time to run.
- API/UI share stale-job detection; legacy missing start dates fall back to creation dates. Recovery remains manual, never an automatic new generation.
- Queue labels and safe error messages give users a next step without printing raw provider content.

## Verification

- TypeScript passes after Next type generation.
- 490 unit tests pass, including concurrent claim, stale-attempt write, owner isolation, caption boundary and provider no-replay regressions.
- One authorized normal-video integration run completed with the caption/provider changes. The worker verified a completed database row and a nonempty private output.
- Later worker-state changes are covered by tests; no second paid generation was used to test them.
- Load capacity and perceptual audio/subtitle synchronization are not certified by these tests.

## Operational limits

Global avatar access remains disabled. No billing-mode or plan changes. Private media, account data and detailed runtime reports remain outside the public repository and public Actions artifacts/logs.
