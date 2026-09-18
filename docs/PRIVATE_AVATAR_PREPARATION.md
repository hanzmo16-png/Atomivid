# Private avatar preparation — 2026-09-18

## Current authorization (supersedes earlier credit-use agreement)

Owner verified production playback, new-video form and Stripe navigation.
Authorized publishing preparation exclusively to their own app account.
NO generation, D-ID credits, purchases or plan changes in this step.
Before one real generation: report expected consumption and obtain explicit approval.

## Implementation

- `/dashboard/new` shows **Video con avatar** only when the verified session email
  exactly matches server-only `AVATAR_PREPARATION_OWNER_EMAIL` (case insensitive).
- Empty configuration denies every account. Do not infer the app identity from GitHub/Vercel.
- `/dashboard/avatar/prepare` and its Server Action enforce the same account check.
- User selects photo and original M4A/MP3/WAV, previews photo, listens to full recording,
  then presses **Guardar preparación**. Combined maximum is 3 MiB.
- Browser metadata displays duration and accepts up to 45 seconds (42.79 is accepted).
  This is a convenience check, not trusted server validation. Before any generation,
  independently decode the saved bytes and measure duration using existing worker checks.
- Server validates photo and audio signatures, stores original bytes and SHA256 manifest
  in existing private `avatar-uploads` under authenticated owner/preparations/random UUID.
- No provider import, provider upload, `video_requests` insert, worker dispatch, TTS,
  audio conversion or generation is performed by preparation. Manifest explicitly marks
  generation unauthorized and duration not yet verified. No new migration required.
- Render endpoint refuses avatar work while AVATAR_MODE_ENABLED is false, before quota
  or dispatch. Existing avatar creation also requires the private owner check.
- Keep production AVATAR_MODE_ENABLED=false and workflow hardcoded false. Worker max
  duration remains 45 seconds. This release does not activate real generation.

## Verification

- PR #4 merged: e6ede72312165022ddeeba726136cd53cbde743b.
- Previous deployment confirmed Production / Current / Ready in Vercel.
- 471 existing tests passed; new private-account authorization test passed.
- TypeScript, changed-file ESLint and production build passed locally.
- No live upload, authenticated UI test or paid generation performed.

## Owner configuration — 2026-09-18

Owner supplied the exact app login email in chat. Configured it as a server-only
Production secret AVATAR_PREPARATION_OWNER_EMAIL in Vercel; no personal email is
stored in this repository. Production redeployment requested with the new setting.
Implementation merged in PR #5, ce921c4360afdf74e6e3cc1cfbe5a6105bd28797.
Generation flags remain disabled; no provider calls or credit consumption.
Authenticated owner UI/upload verification remains pending because the browser app
session is logged out. Owner should refresh Crear video, choose Video con avatar,
select personal photo and full recording, then Guardar preparación. Other accounts
are denied by the server authorization check (unit-tested).

## After files are prepared

Read private manifest and original files only as authorized; verify hashes, decode and
measure full audio duration. Confirm D-ID account/API credits and expected cost from
actual account/official current terms. Report consumption, then wait for owner's
explicit approval for exactly one generation. Do not rely on old cost estimates.
