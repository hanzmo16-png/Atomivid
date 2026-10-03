# VFX production preflight — 2026-10-03

User authorized paid production and deployment, conditional on verifying connections and total budget first. Existing world approvals remain authoritative. No new authorization is required merely because this request resumes later.

## Base generation quote

- FLUX.2 Pro: three text-only background look references at 720×1280, one billed MP each, $0.03 each = $0.09.
- LTX-2.5 Fast: three silent 720×1280, 25fps, six-second motion tests, $0.09/s = $1.62.
- LTX-2.5 Pro: three silent 1080×1920, 25fps, six-second finals, $0.17/s = $3.06.
- Base generation ceiling: $4.77 for nine calls, each dependent on preceding review. No automatic duration; no automatic paid retry.

References: https://docs.bfl.ai/quick_start/pricing ; https://bfl.ai/pricing?category=flux.2 ; https://docs.ltx.io/pricing ; https://docs.ltx.io/models/ltx-2-5 ; https://docs.ltx.io/api-documentation/api-reference/async-video-generation/submit-image-to-video . Rates checked 2026-10-03. FLUX references must contain backgrounds only; Hans continues from original source. This quote excludes reference-image input charges, replacements, taxes, top-ups, FX and unmeasured hosting/storage. It is NOT a verified all-in account debit or credit balance.

## Observed connection state

Both api.bfl.ai and api.ltx.io fail DNS resolution in this execution environment. No authenticated provider requests were sent. Neither BFL_API_KEY nor LTX_API_KEY is present here. This does not establish that credentials are absent in GitHub/Vercel.

Connected Vercel project access was verified read-only: atomivid / prj_d2APVqG7KqQ7ZqZbUVaF50UUwOZQ. Available connector returned project metadata, not provider secrets/account balances. Project access does not verify provider access.

## Blocking work

Run read-only DNS/HTTPS/auth/balance preflight from a reachable authorized execution runner; integrate official BFL/LTX adapters with the existing durable paid-call ledger; prepare deterministic 25fps-to-30fps plate normalization; produce/freeze the actual relight data and matte/clean plate; complete each human world review. Do not bypass missing receipts, unknown billing outcomes or missing reviews.

No generation, new render, publication, remote push or deployment occurred in this preflight. Existing production readiness remains blocked. Pure quote/connection-condition tests pass; preflight explicitly reports productionReady=false. The added preflight utility itself cannot certify authentication or trigger paid operations.
