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
| Production alias `atomivid.vercel.app/r/video-004-pron-gate` | Before the merge: 404. After the merge: 307 → `/login` without a session, 404 for unknown slugs (runs 36904335107 / 36904522424). The authenticated hop then failed on the real device: see RC-002. |

The short route is DELIVERY_PASS only once the user confirms it on the device, per the rule
above.

## RC-002 — AUTHENTICATED_REVIEW_DELIVERY_FALSE_PASS (2026-10-01)

**Symptom.** Real flow on Samsung / Android / Chrome: `/r/video-004-pron-gate` → 307 to the
Atomivid login → successful login (confirmed account, sign-in recorded 18:11:15 UTC) → redirect
back to `/r/video-004-pron-gate` → plain-text `not found`.

**Rule adopted:** `MODULE_PASS + UNAUTH_REDIRECT_PASS ≠ DELIVERY_PASS`. DELIVERY_PASS requires
the authenticated path end to end (session → owner gate → allowlist → private object → bytes).

### Evidence

| Step | Finding |
|---|---|
| URL after login | The login action redirects to `redirectedFrom` verbatim after `safeRedirectTarget` (`/r/video-004-pron-gate` passes: starts with `/`, not `//`, not `/login`). |
| Middleware | `src/proxy.ts` only redirects `/dashboard*`; `/r/*` reaches the route handler. |
| Slug / allowlist | The same URL answers 307 anonymously, i.e. `resolveReviewObject` found the slug; an unknown slug answers 404 with `X-Review-Denied: unknown-slug`. |
| Session | The route returned text (not a redirect), so `auth.getUser()` found the session cookie. |
| Response origin | `not found` as plain text is the route's own body; the Next.js 404 page is HTML. In the first deployment the route used that same text for a failed owner gate. |
| Owner gate configured? | `X-Review-Gate: configured` on production (anonymous probe, run 36906165009): `AVATAR_PREPARATION_OWNER_EMAIL` is set in production. |
| Account confirmed? | Auth admin API (masked): the account that signed in at 18:11:15 UTC is confirmed (created 2026-09-08). Project has `mailer_autoconfirm: false`; 4 accounts exist, three `ha***@gmail.com`. |
| Remaining condition | `canPrepareAvatar(user)` → `user.email.toLowerCase() === owner` is false: the configured owner e-mail is not the e-mail of the account used to sign in. |

**Root cause.** `src/lib/video/avatar/private-access.ts` line 6 (e-mail equality against
`AVATAR_PREPARATION_OWNER_EMAIL`) evaluated for the signed-in account, called from
`src/app/r/[slug]/route.ts` (owner gate). Production configuration names a different account
than the one the owner signs in with. Not a routing, cookie, slug, allowlist or storage fault.

### Fix (authorized by the owner, 2026-10-01)

1. **Diagnosable denials (commits e03e262, 2448f75):** route core in `src/lib/delivery/review-route.ts`
   with injected dependencies; 404 `unknown-slug`, 403 `forbidden: owner-gate-unconfigured |
   email-unconfirmed | not-owner` (header `X-Review-Denied`, same code in the body, nothing else
   leaked), `X-Review-Gate` on every answer.
2. **Dedicated authority (commit 50822e8):** Review Delivery no longer consults
   `AVATAR_PREPARATION_OWNER_EMAIL`. The single allowed account is the Supabase auth user id in the
   server-side variable **`REVIEW_DELIVERY_OWNER_USER_ID`** (`isReviewOwner` /
   `reviewOwnerUserId` in `src/lib/delivery/review-stream.ts`). Authentication, confirmed e-mail,
   allowlist, service-role server-side, Range, `private, no-store` and `noindex` are unchanged.
   Empty variable = nobody. No id, e-mail, key or token is hard-coded in source
   (`.env.example` documents the variable).
3. **Configuration (owner action):** set `REVIEW_DELIVERY_OWNER_USER_ID` in Vercel → Production to
   the user id of the account verified by the real sign-in at 18:11:15 UTC, redeploy, open the same
   link. Until then the route answers `403 forbidden: owner-gate-unconfigured`
   (`X-Review-Gate: unconfigured`), which is how CI verifies the variable's presence without
   printing its value.

### Regression tests (`src/lib/delivery/review-route.test.ts`, fake dependencies, no credentials)

- `AUTHENTICATED_OWNER_GET_DELIVERS_AUDIO_BYTES` — owner session → 200, `audio/mpeg`, exact bytes (sha256).
- `AUTHENTICATED_OWNER_RANGE_DELIVERS_206` — owner session + `Range: bytes=0-999` → 206, `Content-Range: bytes 0-999/N`, exact bytes.
- anonymous → 307 `/login?redirectedFrom=…`; unknown slug → 404 before any session or storage access;
  signed-in non-owner → 403 `not-owner`, nothing fetched; unconfigured gate → 403 `owner-gate-unconfigured`;
  unconfirmed e-mail → 403 `email-unconfirmed`; upstream error → 502 without leaking the storage body.
- `REVIEW_DELIVERY_OWNER_USER_ID is the only authority` — correct owner id → 200 / 206; other confirmed
  account → 403 `not-owner`; anonymous → 307; unknown slug → 404; empty or blank variable → denies all;
  an account matching `AVATAR_PREPARATION_OWNER_EMAIL` but not the id → denied (the e-mail gate is not consulted).

### Spend

USD 0.00.
