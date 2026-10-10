# External podcast editor integration — storage applied, runner pending

## Verified on 2026-10-09

- Input: user-supplied `podcast-editor-entrega.zip`, editor v0.2.0.
- Executed all 42 included unit/integration tests locally: 42 passed, no skips.
- Tests use synthetic media and a local Supabase simulator. They do not validate real Auth, Storage, TUS, or RLS.
- Runtime used FFmpeg 6.1.1; upstream recommends 7.x. Production runner compatibility remains to be checked.
- Current app has audio-only `podcast_episodes`; no video editor bridge is implemented by this change.
- Supabase organization is already Pro; no plan change is proposed. Project-wide upload-size limit remains unverified.
- Private source storage contains six narration MP3s with their timing JSONs, a narration manifest, eight motion MP4s, and eight reference JPGs for Travis Walton. This is not proof that the complete 31-file editing package is present.
- No new media generation or paid provider call was made.

## Approved database change

Migration: `20261009185427_podcast_editor_storage.sql`

SHA-256: `3a8e847d204422844c9938fc3ddc23eff5b7e8893dcb06b119cdc1c4af92b8a7`

Adapted from the delivered `docs/sql/politicas_v2.sql`; removes all DROP operations and all CREATE OR REPLACE operations.

Creates a private `podcast-editor` bucket and a separate `podcast_editor` schema with owner/assignment tables. Both tables have RLS. Assignment helpers check the signed-in user, episode, version, permission, expiry and revocation. SECURITY DEFINER helpers live in the non-exposed schema, use empty search_path and revoke PUBLIC/anon execution. The owner lookup uses auth.uid(); anonymous callers cannot execute it.

The editor can read assigned input and insert output/status only. It can read its own output for integrity checking and signed URLs. It receives no UPDATE, DELETE, production-table or other-bucket access through this migration. The producer optionally has insert/read permissions for input. Existing buckets and policies are unchanged. No owner or editor is enrolled automatically.

## Deployment status

**APPLIED** after Hans explicitly approved both the exact SQL and publication of the technical proposal on 2026-10-09. Remote migration version: `20261009185427`. SQL bytes and SHA-256 above are unchanged from the approved ZIP; filename matches remote migration history.

Production verification confirmed: private bucket, both new tables have RLS, seven bucket-specific SELECT/INSERT policies, three assignment policies, zero owners and assignments. Existing five buckets retain their privacy and size-limit settings. Global upload limit and billing plan were not changed. No credentials or media were published.

Before applying, the exact approved SQL was also executed against local PostgreSQL 17.5 via PGlite 0.3.14, using the later review package's Supabase catalog emulation and test matrix. Result: 492 security checks, 8 positive controls and 8 design observations passed. Three preexisting direct-SQL TRUNCATE grants were reproduced; these are not introduced by this migration and are not exposed as operations in ordinary Storage/PostgREST. See `podcast-editor-approved-sql-tests.json`. This is not a live HTTP or JWT-signature test.

The later 25 KB candidate is a DIFFERENT SQL revision and was not substituted for the exact authorized 8 KB SQL. In particular this applied revision has no bucket-specific 5 GiB setting, retains its all-row assignment uniqueness constraint (reassignment after revocation needs a future migration), and has no automatic preexisting-policy guard. The current production catalog was checked immediately before application and had zero Storage policies. Future policy changes require a fresh isolation review.

Post-apply advisors show an expected informational no-policy notice for the intentionally inaccessible owners table. No policy should be added just to silence that notice. Existing Auth leaked-password-protection warning remains outside this change:
https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
RLS notice reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

## Remaining acceptance gates

1. Database step completed; no owner/editor enrollment has been performed.
2. Provision a dedicated editor Auth user through a supported authenticated administration flow. Keep its password out of chat, source control and artifacts; never give the runner service_role or provider keys.
3. Assign a temporary synthetic episode/version. Validate real login, refresh, fetch, render, TUS publish, duplicate handling, signed playback/download, expiry and cross-episode/input/write/delete denials.
4. Locate the complete real 31-file input package, verify manifest and hashes and existing upload limit; upload LISTO.json last. Do not regenerate any paid assets.
5. Run the real montage in the external editor, verify full audio and image quality, then publish COMPLETO.json last.
6. Wire owner-authenticated result retrieval to the app. Do not mark the app integration complete before real playback/download is verified.

Public publication of this technical proposal was explicitly authorized together with the SQL. The PR is a record of the applied database change; it does not activate a runner or claim full app integration.

This review package contains no credentials, account identifiers or media.
