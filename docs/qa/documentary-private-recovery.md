# Private recovery of failed documentary preparation

The approved provider response remains in private storage when editorial validation fails, but previously no readable draft was retained in the owner's job. Recovery now preserves an explicitly unapproved checkpoint before review and after a valid review. A failed checkpoint write stops before the next review request. Call fingerprints and the single rewrite budget are unchanged.

The job page authenticates the owner and reads through the existing owner-only RLS policy. It shows a collapsed draft with a pending-approval label and no production control. Checkpoints are not accepted by the production path and do not create video requests.

The scoped diagnostic can optionally write its offline replay checkpoint back to the SAME failed job. It replaces all provider networking with exact saved-response lookups, refuses a missing response, and uses job ID, user ID, failed status, null run token and updated_at as a compare-and-swap lease. It does not requeue, approve, reserve funds, or generate media. No script, prompt, signed URL, credential or encrypted private-data bundle is published in GitHub output.

Verification: 79 editorial/render tests, Next route type generation, TypeScript and targeted lint. Coverage includes persistent rejection with retained drafts, callback isolation, write-failure stop, visibly unapproved markup, and HTML escaping. Production recovery and deployment outcomes must be recorded separately after execution.
