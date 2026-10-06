# Documentary references and saved-response replay

## Fault boundary
The critic and visual planner previously generated both quoted text and a block index. Those fields could disagree even when the narration itself passed creative and duration checks. A citation-only repair could itself carry a quote from a different block. Testing an individual validator did not prove the rest of the documentary would complete.

## Contract for new requests
New durable jobs store `referenceContract: catalog-v1` in their immutable input. The server derives 5–12-word literal excerpts, each identified by a hash of the complete narration plus its block and word offset. The critic and visual planner choose IDs; the server obtains the text and location. Unknown or stale IDs, wrong block coverage and real editorial defects fail closed. No citation-generation retry is added.

Existing jobs omit this version and retain their original research, writer, critic and visual request fingerprints. They are not silently migrated or resubmitted. The duplicate-input guard remains unchanged.

## Recovery of completed legacy corrections
A saved correction can relocate a finding's pointer only if its supplied quote occurs exactly once in the entire draft. Required section/first-answer/ending pointers cannot be relocated this way. The original location, final location and literal quote are audited and revalidated on load. Findings, severity, explanation and repair remain intact. Ambiguous, invented and partial quotes still fail. This does not assert independent factual verification.

## Verification boundaries
- Unit and SDK-transport fixtures cover writer → critic → all visual blocks → validated output without provider calls.
- The read-only diagnostic downloads already-committed responses inside the runner, replaces all subsequent networking with exact-parameter-hash response lookup, and replays the actual saved inputs. It reports only structural counts and fixed stage labels; no private text or encrypted content is exported.
- A missing saved response stops replay before provider execution. Reaching that boundary is NOT completion of the missing stage or proof of final audiovisual quality.
- No failed production job is automatically requeued by this release. No spending limits, voice quotas or uncertain-operation states change.

Saved-response replay on 2026-10-06 reused six exact parameter fingerprints, preserved four findings, and recovered one unique literal citation location. It then stopped at a genuine editorial gate: a section was classified as restatement. Creative consistency and duration checks passed. No missing/new provider response was requested, no approval was emitted, and the job must not be advertised as ready or simply requeued. The interface now distinguishes this quality stage from citation processing. This result does not establish that the critic's qualitative judgment is correct; it establishes the precise remaining blocker without more spend.
