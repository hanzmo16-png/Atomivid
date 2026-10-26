# Podcast video dispatch uncertainty — 2026-10-18

Base: production commit `546a79250f68bcc32bb82cfcb11b381f9306c9e2`.
Branch: `codex/podcast-dispatch-uncertainty-20261018`.
Scope: `requestPodcastVideo`, its tests and this audit. No worker/Director changes.

## Cause and reproduction

After a durable queued claim, a false result from `dispatchPodcastJob` was converted into `video_status=failed`, without an attempt-token fence. A lost response does not prove the dispatch was rejected. This unlocked immediate retries while a GitHub event might already have been accepted. The late failure write could also modify a newer queued attempt. Claim database errors were mislabeled as competing requests, and rejected claims escaped.

Eight added behavioral cases exercise the real request function, an in-memory stateful database evaluating its predicates, and a substituted fetch (no real network): accepted-but-response-lost, three newer-attempt states, returned/rejected claim error, HTTP 503, and simultaneous admission. Before correction: **13 tests, 6 pass / 7 fail**, including the five existing tests. After correction: **13/13**.

## Correction

Preserve the durable claim on an unconfirmed dispatch. Do not write a terminal failure, reset the token, alter a newer attempt, automatically resend, or tell the user that retrying cannot charge twice. Return a clear 503 requesting a state refresh. An unreadable claim returns safe 500 without dispatch; zero matched rows remains a 409 conflict.

The existing 12-minute stale-job guard and attempt/budget controls are unchanged. Missing dispatch configuration and explicit HTTP rejection conservatively retain the claim too; recovery may wait for the existing stale interval. This favors safe admission over immediate retry.

## Evidence

- Local video/pilot/run-budget suites: **32/32**.
- `next typegen`, `tsc --noEmit`, full `eslint .`: exit 0.
- `git diff --check`: clean.
- Tests remain in the existing `video.test.ts` test:unit/test:saas entrypoint; package.json unchanged.
- File lists of open PR131/136/137 checked: no modified files overlap. PR138 is independent too.

## Limits

This is not exactly-once dispatch or provider billing verification. The older background-narration dispatch path, scheduler dispatch, and worker admission still need separate audits. In particular, stale recovery uses a previously read heartbeat and worker duplicate admission needs verification within its assigned PR131 scope. This patch neither changes that worker nor bypasses ownership of that work.

No production data/financial records, secrets, migrations, paid calls, merge or manual deploy. Live-account acceptance and production rollout are pending. GitHub's free synthetic CI is separate evidence from local tests.
