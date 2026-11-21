# PR138 — recording durability audit (2026-10-18)

## Verified baseline

- PR138 initial head `c17efafdc2c01de7fe20517f112ae0ac760e253f`, draft, CI `39099481168` / job `117592619042` successful.
- Production deployment `dpl_AiESpKbm9NcH7TdtLnZG9LYhKgJX` READY at `546a79250f68bcc32bb82cfcb11b381f9306c9e2`; does not contain this PR.
- Read-only schema check confirmed existing `user_id`, `status`, `run_token` (uuid), `run_started_at`, `audio_path`. No migration needed or run.
- Open PR131/136/137 file lists checked: no overlap with this patch. No changes to their branches.

## Reproduced defects

The initial static test passed, but executing the actual POST route with controlled external failures exposed two additional defects:

1. Upload used `episode.m4a` with upsert before committing the row. A failed final write or a stale worker could replace the bytes of the previously delivered audio while its old path/hash remained recorded.
2. Transport promise rejections could escape the route, including rejection of the failure-state write.

The 26 behavioral cases against initial head yielded **14 pass / 12 fail**. They run the actual route transpiled by TypeScript in a VM with a strict module allowlist and synthetic auth, DB, storage and audio mastering. No network or paid provider is available to that VM. Query predicates are evaluated on shared mutable state at the write, including racing requests.

## Minimal correction

- Immutable `recordings/<run_token>.m4a`, `upsert:false`; no deletion or overwrite of previous audio.
- Keep original upload until exactly one owner+run+generating final DB write confirms ready.
- Unknown exceptions return safe JSON 500 without deleting, unlocking or retrying ambiguous work.
- Await failure-state writes inside the error boundary.
- Behavioral suite imported by the existing `server.test.ts` test:unit entrypoint, avoiding package.json conflicts.

## Local verification

- Behavioral route cases: **26/26**. Includes failed/rejected/zero-row claims and terminal writes; audio download/upload/decode failure; cleanup failure after durable success; two simultaneous finalize requests (one master/upload); stale success/failure with changed owner, run or status; unauthorized/foreign owner; invalid requests.
- Podcast suites (server, episode, pilot, video, visual, notice-check, run-budget): **72/72** (26 cases counted once).
- `next typegen`, `tsc --noEmit`: exit 0.
- Full `eslint .`: exit 0. `git diff --check`: clean.

## Boundaries and residual risk

- Local behavior proof with synthetic dependencies is not live Postgres locking, real storage/media processing, authenticated account acceptance, or production validation. Existing media tests run separately; actual mastering is intentionally substituted in this route suite.
- An ambiguous commit can leave `generating` or orphaned immutable output. Automatic reconciliation/resume and retention need a separate bounded design. No automatic cleanup of unreferenced outputs is introduced.
- Repeated sequential finalize is not made idempotent here; only overlapping admission is guarded. No claim of complete recovery.
- Video/audio version coordination when replacing narration needs its own audit.
- Draft delivery only; no merge, manual deploy, migration, secret, financial record or paid-provider change.
