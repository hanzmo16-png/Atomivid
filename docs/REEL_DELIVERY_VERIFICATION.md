# Reel delivery verification — 2026-10-05

Scope: close the existing owner reel flow, with no additional provider calls or new product features.

## Observed evidence

- Preview `608e1da49f78174be25b94c34ea5a8e3d7bcc4b2` is READY in Vercel.
- The principal owner signed in through the secure browser authentication capability. The authenticated history and dedicated result page both show the completed business reel as Listo.
- Explicit navigation back to the same result page preserved the authenticated result. This is evidence of result persistence, not a new generation or render-admission click.
- A read-only database/storage check confirms completed status, one render attempt, no error, and an existing private `video/mp4` object of 5,809,682 bytes.
- The preceding delivery audit passed technical checks and sampled visual review for the 30.784-second MP4. Those checks do not certify browser playback or downloads.
- The browser first reported Unable to play media, then buffering after navigation. Native credential protection blocked screenshot emission and the browser download operation. Do not infer file corruption, successful playback, or successful download from this evidence. Do not bypass the browser restriction.

## Corrections prepared

- History uses the same Storage download option as the dedicated result page, while preserving the original playback URL.
- The dedicated result page uses the existing stale-production guard, shows a clear delay message, and refers the owner to the history rather than continuing to display active progress indefinitely. It neither resets the request nor starts another paid attempt.
- Long Form uses its existing heartbeat rule: a recent progress heartbeat keeps a long-running production active even if its start is old.

Validation: 37 focused tests passed, including stale-state regression cases, progress in all existing modes, tenant-scoped signed links, render admission, and paid recovery isolation. Typecheck, changed-source ESLint, and diff whitespace checks passed. React review: pure server-side derivation, no new hooks or data fetches, existing accessible warning and navigation, no additional dependencies.

## Still required

1. COMPLETED: delivery corrections `20e137529c3577172f8f2acb8d4f67fdb34fb86a` are READY in Preview deployment `dpl_DJcQE8aicnniS7BbQZ6kQCuyQjVx`, confirmed by the Vercel connector after the owner deployed them.
2. Complete browser playback and download verification when this browser permits them. Compare the downloaded bytes with the accepted MP4 without generating again.
3. Prove the normal authenticated render-admission click and live progress separately. The completed request must not be reset or regenerated to manufacture that proof.
4. Keep production activation and quality-feature rollout separate from this read-only result verification. Owner approval and actual applicable budget remain necessary for any further provider consumption.

No new paid calls, changes to subscription/quota, request state, grants, or financial receipts were made during this verification.

## Follow-up server delivery check

The authenticated result page on the new Preview again showed Listo. Native credential protection blocked console inspection and the UI download-event check; the browser runtime reset after its rejected asynchronous observation. No playback or UI-download success is claimed, and no further browser workaround is attempted.

`owner-reel-delivery-check.ts` checks the exact already accepted object in an isolated worker with existing server credentials. It creates its own 120-second URL using the same owner-scoped signing helper as the page, checks full-byte hash, media MIME, byte-range delivery, download attachment headers, and unsigned denial. It reads no browser credentials, cookies, signed URLs or network state. It never generates, resets the completed request, or changes paid receipts. Only a private technical report is written under the owned request; public logs contain categorical pass/fail. The normal browser flow still requires separate evidence.

### Confirmed server result

Worker commit `33749f9b95227714b3fd6b0ea641fdda4619c4fe`, Actions run `37306651108`, checked at 2026-10-05 12:01:31 UTC. The private Storage report was read independently through its technical metadata: all 13 checks passed, failure null, provider calls zero. Full signed read returned HTTP 200 with `video/mp4` and exact accepted byte length/hash. Byte-range and download requests returned HTTP 206 with matching bytes; the download response included attachment disposition and the intended filename. The same path without its signature was denied with HTTP 400. The owned completed request remained unchanged. Browser playback and UI download remain explicitly unverified.
