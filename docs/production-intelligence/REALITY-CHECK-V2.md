# Production Intelligence V2 — Reality Check incidents

Incidents where a check that passed in CI did not survive contact with the real device or the
real user. Each entry records the evidence, the demonstrated (or undemonstrated) root cause and
the policy change. PI V1 / V1.1 (`src/lib/production-intelligence`) is frozen and is NOT
modified by these entries; they are V2 inputs.

## RC-001 — REVIEW_DELIVERY_ANDROID_INVALID_JWT (2026-10-01)

**Labels (user's classification):** RB-05, RB-06, Delivery QA.

**Symptom.** A Supabase Storage signed URL for a private review object (first the Thermopylae
480p review MP4 at 11:48 UTC, then the V3 pronunciation-gate review MP3 at 16:24 UTC) was
verified from a GitHub runner as GET 200, Range 206, correct content-type, and failed on the
user's Samsung / Android / Chrome with `400 InvalidJWT "signature verification failed"`.
A re-signed URL for the same MP4 (12:07 UTC) opened on the same phone.

**Rule adopted:** `RUNNER_HTTP_200 != DELIVERY_PASS`. A runner-side pass is a *RUNNER_PASS*;
only confirmation from the user's device turns it into *DELIVERY_PASS*
(`classifyReviewDelivery` in `src/lib/delivery/review-stream.ts`, regression test
`LONG_SIGNED_URL_RUNNER_PASS_IS_NOT_SUFFICIENT_FOR_DELIVERY_PASS`).

### Evidence (diagnostic run `video-004-review-delivery-diag.yml`, 2 runners, 16:52 UTC)

| Question | Finding |
|---|---|
| Was the URL in chat the URL the runner tested? | Yes. sha256 of the chat URL = sha256 of the URL stored in the gate report (`0b1fda7f…7a19`). All 8 signed URLs delivered in this session match their tool-result originals byte for byte. |
| Token / URL shape | URL 468 chars, token 335 chars, only `[A-Za-z0-9._-]` (URL-safe), 0 underscores, 3 dashes, 2 dots. Well under any browser or Android intent limit. |
| Redirects | None (HEAD without follow: 200, no `Location`). |
| Query-string preservation | Dropping the query gives a *different* error (`querystring must have required property 'token'`), so the device did send a token. |
| Supabase signing | Header `{"kid":"5b494a19-…","alg":"HS512"}`, claims `{url, scope:"download", iat, exp}`. The kid is a symmetric Storage key, not published in `/auth/v1/.well-known/jwks.json` (which lists one ES256 key) — expected for HS keys. |
| Key / version mismatch, TTL, clock | Token issued 16:21:52 UTC, valid 8 days; verified again 31 minutes later from two runners: 20 fresh connections over HTTP/1.1 and 20 over HTTP/2, all 206; Chrome-Android header set with `Range: bytes=0-` → 206 full body; plain navigation → 200. Same Cloudflare edge class (`cf-ray …-DFW`), `cf-cache-status` MISS then HIT. No key rotation and no expiry in the window. |
| Caching | A 400 is never cached; the first probe was a cache MISS and still 200. |
| What produces the user's exact error text? | Truncating the token by 8 characters, or replacing `-` with `+` (non-URL-safe re-encoding): `400 InvalidJWT signature verification failed`. Appending one character still verified (lenient base64url decoder). |
| Bucket | Anonymous GET on the `/object/public/` path → `Bucket not found`: the bucket is private. |

### Root cause — what is demonstrated and what is not

Demonstrated: the delivered URL was correct and the server accepted it, from two independent
networks, with the device's own header pattern, before and after the user's attempt. The
signature failure therefore occurred on a token whose bytes differed from the delivered ones,
and the only transformations that reproduce the exact error are truncation or character
substitution of the token. The server-side candidates (signing key rotation, kid mismatch,
expiry, clock, redirects, caching, query loss) are excluded by direct measurement.

Not demonstrated: *which* component between the chat message and Chrome's request altered
the token (chat rendering/copy on Android, the intent hand-off, or the address bar). This
cannot be observed from CI; it would need the URL as received by Chrome on the device.
The earlier MP4 case fits the same pattern (first URL failed, a re-signed URL of equal length
in the same chat format opened), which rules out a systematic length or format limit and
points to a non-deterministic alteration on the delivery path.

### Fix (minimum, existing infrastructure only)

1. **App-controlled short review link** `/r/<slug>` (`src/app/r/[slug]/route.ts`):
   owner-only (same single-account gate as `/dashboard/admin/p2b-veo`), server-side fetch of
   the private object with the service key, `Range` forwarded (200/206), forced `Content-Type`,
   `private, no-store`, `noindex`; static allowlist of review objects (no DB, no migration); no
   JWT reaches the client; nothing is logged. Merged to the production branch in PR #27
   (4 files: the route, `src/lib/delivery/review-stream.ts`, its test, `package.json`).
2. **Policy:** signed URLs remain valid for CI verification and for desktop use, but a review
   hand-off to a phone is only *DELIVERY_PASS* once the user confirms on the device.
3. A file attached in the chat was also tried and did not reach the user: chat attachments
   are not a delivery channel for this project either.

### Regression test

`src/lib/delivery/review-stream.test.ts` —
`LONG_SIGNED_URL_RUNNER_PASS_IS_NOT_SUFFICIENT_FOR_DELIVERY_PASS` and the route invariants
(allowlist, Range forwarding, header hygiene, token redaction).

### Spend

USD 0.00 (no TTS, no image/video generation; read-only probes and one storage read).

### Verification of the fix (`video-004-review-route-check.yml`, runs 36895735310 / 36895905906)

| Check | Result |
|---|---|
| Upstream path used by `/r/<slug>` (service key, authenticated endpoint) | full GET 200 `audio/mpeg` 536,703 bytes sha256 `47dd7267…3d5a` (identical to the gate artifact); `Range: bytes=0-999` → 206 `bytes 0-999/536703`; open range → 206 `bytes 100000-536702/536703`; client headers `private, no-store`, `Accept-Ranges: bytes`. |
| Branch preview | Vercel Deployment Protection (302 → `vercel.com/sso-api`) in front of the app; the repository holds neither `VERCEL_AUTOMATION_BYPASS_SECRET` nor `VERCEL_TOKEN`, so CI cannot see behind it. |
| Production alias `atomivid.vercel.app/r/video-004-pron-gate` | Before the merge: 404. After the merge: see the production smoke test recorded in the session log; the route answers 307 → `/login` without a session, 404 for unknown slugs, and streams the audio only to the owner account. |

The short route is DELIVERY_PASS only once the user confirms it on the device, per the rule
above.
