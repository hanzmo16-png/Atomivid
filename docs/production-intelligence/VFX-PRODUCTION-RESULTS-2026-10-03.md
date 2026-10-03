# VFX preparation result — 2026-10-03

Status: PARTIAL_MATERIALS_REVIEW_REQUIRED. Not production-ready or fully certified.

The owner explicitly approved the three independent directions at 17:49:10 UTC: NYC night practicals, beach soft daylight, moon hard sun with a distant uncrewed rover. Authorization covers one FLUX.2 Pro background per environment, maximum $0.09 for this batch. No motion, master render, or deployment was executed.

| Environment | Durable result | Ledger | Review |
| --- | --- | --- | --- |
| NYC | PNG stored, SHA256 e8c3d0aa4033b9cb116cd952aede6f094fd08f23e2b47c93bc2d733932a65f23 | $0.03 committed using published-rate basis | Visual approval required |
| Beach | Accepted job 9461fdbd-c308-4d7e-9607-24d11978912f, result polling now HTTP 404 | $0.03 reserved, settlement pending | Blocked; never resubmitted |
| Moon | PNG stored, SHA256 f0e4568511b7108381e39bb3e2d2611ab37fde36c6d087b194055553bb113d7c | $0.03 committed from provider usage | Visual approval required; Director artifact registration awaits prior missing styleframe |

The previous adapter reconstructed the polling URL and failed to persist the provider receipt. This was corrected: accepted job ID, exact returned polling URL, and reported cost are stored atomically; subsequent runs resume the same request. Legacy beach receipt was reconciled against the documented regional result API, which returned Ready, but its download failed and later polling returned HTTP 404. Expiration is a possible cause, not confirmed. Recovery requires BFL to restore the existing job/result or explicitly reconcile it; a new paid beach request is not automatically authorized.

The original private source remains unchanged: SHA256 5d6e025f43a0f27e3835330edd79dcef46742a7e565ecb158cffefaf7f990e7b, 1080x1920, 30 fps, 150 frames. No original source was exported by this branch's workflows. Only generated background PNGs were exported for review.

Validation: 41 scoped tests, type generation, TypeScript checks, and lint passed in GitHub Actions run 37144085322. Real BFL image submission, durable receipt, download, storage, and cost settlement succeeded for Moon. The material batch correctly reports failure because Beach remains blocked. The physical matte, per-world relight/composition, visual approvals, and final cut/grain render remain unverified; passing core tests does not certify those outputs.

Changes are on codex/vfx-sequence-compositor, with deployment disabled for that branch. Do not merge or deploy this as a fully closed production certification.
