# VFX production preflight — 2026-10-03

User authorized paid production and deployment, conditional on verifying connections and total budget first. Existing world approvals remain authoritative. No new authorization is required merely because this request resumes later.

## Base generation quote

- FLUX.2 Pro: three text-only background look references at 720×1280, one billed MP each, $0.03 each = $0.09.
- LTX-2.5 Fast: three silent 720×1280, 25fps, six-second motion tests, $0.09/s = $1.62.
- LTX-2.5 Pro: three silent 1080×1920, 25fps, six-second finals, $0.17/s = $3.06.
- Base generation ceiling: $4.77 for nine calls, each dependent on preceding review. No automatic duration; no automatic paid retry.

References: https://docs.bfl.ai/quick_start/pricing ; https://bfl.ai/pricing?category=flux.2 ; https://docs.ltx.io/pricing ; https://docs.ltx.io/models/ltx-2-5 ; https://docs.ltx.io/api-documentation/api-reference/async-video-generation/submit-image-to-video . Rates checked 2026-10-03. FLUX references must contain backgrounds only; Hans continues from original source. This quote excludes reference-image input charges, replacements, taxes, top-ups, FX and unmeasured hosting/storage. It is NOT a verified all-in account debit or credit balance.

## Observed connection state

The local execution environment cannot resolve the provider hosts. GitHub Actions run 37137364457 successfully verified DNS and HTTPS for both official APIs. Its report found neither BFL_API_KEY nor LTX_API_KEY available to that workflow. Authentication and balances remain unverified. No generation occurred.

Connected Vercel project access was verified read-only: atomivid / prj_d2APVqG7KqQ7ZqZbUVaF50UUwOZQ. Available connector returned project metadata, not provider secrets/account balances. Project access does not verify provider access.

## Blocking work

Official BFL/LTX adapters now use the existing durable ledger and result store through gatedWorldAsset. Tests cover failure before submission, frozen attempt slots, approved references, recovery without resubmission and reuse. The dedicated preparation command remains blocked without fresh authenticated connection evidence and reviewed materials. normalize-plate.ts provides native-size 25fps-to-30fps duplication/drop conversion without optical interpolation. Actual source windows, matte, clean plate and frozen per-world lighting still need preparation and review; these utilities do not certify campaign production readiness.

No paid generation or deployment occurred. Changes are on the isolated codex/vfx-sequence-compositor branch, whose automatic Vercel deployment is disabled. Preflight reports productionReady=false. With credentials, the check reads BFL credits and requests an LTX upload authorization without uploading media or generating video; LTX balance still needs evidence from its official console.

## Owner steps

1. Create official API keys in https://dashboard.bfl.ai and https://console.ltx.io .
2. In https://github.com/hanzmo16-png/Atomivid/settings/secrets/actions create repository secrets BFL_API_KEY and LTX_API_KEY. Never paste keys into chat or screenshots.
3. Supply the LTX API credit balance only. BFL credits can be checked through its official API. Required base consumption is $0.09 BFL and $4.68 LTX; minimum purchases, taxes and hosting/storage are additional and must be checked before calling this a total budget.
4. Re-run the no-generation provider preflight. Then prepare and review one frame per environment, then each motion preview, then final plates. Preserve unrelated approvals. No master composition is accepted with a rejected defect.

Validation: adapter tests pass, TypeScript and lint pass. Full unit run had one AAC loudness failure (-18.01 LUFS); all six audio tests passed when run separately. Do not describe the full run as green or the project as 100% certified.
