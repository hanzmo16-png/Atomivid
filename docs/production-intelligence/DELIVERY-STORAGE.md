# Delivery / Storage

**What.** `src/lib/delivery/policy.ts` + table `delivery_assets` (migration 0025, not applied).
**Why.** DULCE Part I had to be split into 45 MB parts under the old 50 MB limit and needed a later "single MP4" stage to be playable on a phone. With Supabase Pro (500 MB global limit) masters are single files.

## Policy
| Type | Retention | Notes |
|---|---|---|
| MASTER | keep (never auto-deleted) | ONE progressive MP4 (`video/mp4`, moov before mdat) whenever it fits the limit; parts only as a legacy fallback |
| MANIFEST | keep | checksum, size, duration, provenance |
| PREVIEW | 90 days | regenerable |
| HLS | 30 days | only when streaming helps; regenerable |
| INTERMEDIATE | 30 days | segments, parts, work files |

Each record: projectId, assetType, storagePath, checksum (sha256), size, duration, contentType, progressive, createdAt, retention. **Signed URLs are credentials**: generated on demand, never stored in git or the DB (a DB check rejects `token=` or http URLs as paths).

Anonymous acceptance for a master URL (as verified for DULCE Part I): range request → 206, `Content-Type: video/mp4`, `Accept-Ranges: bytes`, ffprobe duration matches, moov first.

Reuses: `output-policy.ts` (`configuredStorageMaxBytes`, size estimates, error classes), `output-upload.ts` (TUS resumable upload), `storage/signed-url.ts`, and the DULCE `single-mp4` stage as the reference implementation.

## Not implemented yet
Retention sweeper (deliberately none: nothing is deleted in V1); wiring `delivery_assets` writes into render stages.

## Review hand-off to a phone (RC-001, 2026-10-01)

A long signed URL that passes from a runner is a RUNNER_PASS, not a DELIVERY_PASS
(see REALITY-CHECK-V2.md). Reviews meant for the user's phone go through the app's short
route `/r/<slug>` (owner login, server-side fetch with the service key, Range forwarded, forced
Content-Type, bucket private, no token in the URL). Allowlist: `REVIEW_OBJECTS` in
`src/lib/delivery/review-stream.ts`.
