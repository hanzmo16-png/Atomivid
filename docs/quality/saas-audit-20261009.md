# ATOMIVID SaaS audit — 2026-10-09 UTC

Baseline: production/default branch `4bc2edf3a3fc6f79e03fbb32951d3f6a8e31b94e` (PR #80).
Work isolated in `codex/saas-audit-20261009`. No paid generations, billing transactions,
provider cap changes, or changes to Claude's episode jobs were initiated by this audit.

## Confirmed defects and corrections

1. **Stripe delivery was acknowledged despite failed persistence.** Both lookup and
   upsert errors were ignored. Reproduced with signed test events: expected 500, got
   200. Errors now return safe non-2xx responses for Stripe redelivery. Subscription
   changes retrieve current Stripe state rather than trusting an old event snapshot;
   terminal changes match the stored subscription ID so an old cancellation cannot
   cancel a replacement. Duplicate delivery does not initiate payment.
2. **Client roles could insert internal production fields.** Production column grants
   allowed authenticated INSERT of output paths and production-confirmation fields;
   the ownership-only insert policy did not restrict them. The two normal creation
   paths now use the server client after `auth.getUser()` and all existing validation.
   Migration revokes browser writes for video requests and avatars, including legacy
   column-level grants. RLS owner reads and service-role workers remain intact.
3. **Script saves could falsely succeed or race a render/another edit.** Full script,
   manual edit and scene regeneration now require a confirmed write matching owner,
   status, render attempt and previously read JSON. Storage failure returns 500;
   a changed request returns 409. Failed generation cannot erase a concurrent result.
4. **Monthly quota used the draft's creation month.** Usage now uses render start,
   with a creation-date fallback for legacy rows, and an explicit UTC month boundary.
   Missing counts fail closed rather than being interpreted as zero.
5. **Guarded AAC mastering could return an excessive true peak.** Baseline suite failed
   at -1.13 dBTP against -1.5 dBTP. A limiter now controls transients after resampling,
   followed by measured, bounded correction and rejection if still out of range.
   Lookahead compensation is compatible with the older bundled FFmpeg used by podcast.
   Seeded stress signals make the regression reproducible. Measured loudness correction
   also handles quiet inputs under-normalized by bundled FFmpeg. Corrections encode
   from the original input, with duration trimming to prevent filter tail/padding
   from extending audio. Both supported executables pass loudness, peak and duration checks.

## Verification

- Baseline general suite: 1,602 tests, 1,601 pass; the audio failure above was retained
  as a real finding, not dismissed by retrying until green.
- Final general suite: 1,616/1,616 pass, including the final audio compatibility
  and duration corrections. Bundled-executable audio suite: 6/6 pass.
- Spend controls: 102/102. Editorial controls: 120/120.
- TypeScript, targeted ESLint, whitespace checks pass. Next.js production webpack
  compilation completed successfully; hosted deployment remains the final release gate.
- HTTP baseline: home/login/register 200; dashboard and Command Center redirect to
  login; administrative API rejects unauthenticated access. No authenticated browser
  or paid checkout/render was exercised by this audit.
- Database: all five observed storage buckets private; examined SECURITY DEFINER
  functions have no anon/authenticated EXECUTE grant. Security advisor reports no
  missing-RLS-table error. Tables without client policies are server-only by design.
- CI now runs `test:saas` in the existing no-paid-provider workflow.

## Deployment order

1. Merge and verify the production web deployment, including server-owned creation.
2. Apply `server_owned_generation_writes` through the migration tool.
3. Verify table AND column write privileges are absent for client roles and retained
   for service_role; verify read privileges and existing RLS remain.

The privilege migration does not update/delete content or alter the running paid ledger.
Do not roll back to a pre-audit web deployment without addressing its old direct inserts.

## Remaining limits, not declarations of success

- Real payment delivery, signed-in customer navigation and paid media generation need
  live end-to-end evidence; simulated tests do not certify those paths in production.
- Retail quota count and render admission are separate operations; this audit does not
  introduce a transactional per-customer quota reservation for simultaneous different
  requests. Global/provider supply reservations and paid-call gates remain in place.
- Seven older nonterminal ledger entries were observed. Their reservations were NOT
  released or replayed without evidence of provider outcome. The contemporaneous
  ElevenLabs operation was active and was left alone.
- Supabase leaked-password protection is disabled; no supported authenticated config
  mutation was available in the inspected connector. Remediation:
  https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
- Performance advisor reports unindexed foreign keys; no speculative index rollout or
  deletion of existing indexes was performed without workload evidence.
- A clean deployment/test suite is not a guarantee that no other defects exist.
