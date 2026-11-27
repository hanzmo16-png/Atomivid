# Final integration — implementation candidate, not production certification

Base production: `6815e4831492d5d51af2cd8be2cd8c0b26b0b031`. Existing PR338 branch updated by ordinary merge; original preserved under backup/resource-sentinel-before-final-integration. PR337 remains Claude-owned; coordination is in its existing conversation. No merge, deployment, production migration or native corrector activation is included.

## Audio financial correction

`paid-supply-port.ts` journals synchronous TTS in existing `pi_paid_operations`, reserves all unique missing segments in existing `pi_supply_job_reservations`, and enforces immutable authorization/manifest through a service-only RPC. The new SQL authorization registry contains no second accounting ledger and no synthetic video requests. Video and Audio reuse one envelope admission helper. Existing installed Reel/recovery/Podcast authorization wrapper is preserved in a private schema rather than reconstructed. Costs from configured TTS tariff remain ESTIMATED, never provider invoices.

Production worker and local inline worker accept the same financial port. Exact local demo/fixture adapters remain free. Missing migration/policy/capacity refuses uncached real speech; this is a release dependency, not the commercial final solution. Existing cached legacy speech remains usable without a new provider send. Interrupted SUBMITTED calls require reconciliation. A persisted local receipt verifies cached SHA-256 without inventing a provider job ID. PJR resumes settlement; a missing or corrupt committed cache requires restoration. SQL usage repairs lost JSON counters without resetting spend. Revision/authorization checks prevent observed stale workers from publishing over changed projects; Storage JSON itself is not a transactional CAS, so this is not a claim of universal cross-process storage fencing.

Migration `20261127050646_audio_supply_authorization_contract.sql` is PREPARED ONLY. Application requires express approval and confirmation of the exact installed financial wrapper chain. Local PostgreSQL tests load both repository migrations and the existing authorization/Podcast accounting proposals before applying Audio. Two known local-only extension migrations are identified by name, not silently counted PASS. Rollback keeps all financial history, refuses new Audio sends and preserves the prior wrapper for other products; quiesce workers and restore application first. Neither migration nor rollback was applied remotely.

## Sentinel communication

GitHub OIDC in the existing Preview workflow authenticates a new GET availability projection. Repository/default branch/workflow/environment/audience are pinned. The response contains only timestamp and four product readiness booleans with generic reasons. No amounts, accounts, private operations or identities leave the server; no QA elevation. OIDC stays in the Node worker, never browser DOM, queue or Drive. Unknown coverage remains false/BLOCKED. This read does not reserve resources or authorize generations.

## Remaining release gates

- The 26 original BLOCKED are individually preserved in `blocked-26.json`; no fixture is substituted for production evidence.
- Only schedule run45938752780 is currently accredited; no second consecutive schedule or live bridge success is claimed.
- Shared FLUX/Recraft wallet display remains deduplicated. The existing conservative admission hold remains when both aliases are enabled: this change does not certify atomic shared-wallet admission or race-free administrative policy flips.
- Legacy Audio/Podcast cross-product accounting and worker/GPU/storage/rate-limit coverage remain unverified, not invented as zero. Do not remove `uncoveredProviders` on the basis of these offline tests.
- Claude PR337 integration and live admin controls need authentic coordination and authorized release; no external Claude session activation is claimed.
- Native corrector remains under HOLD. Proposed bounded contract is in `corrector-permissions.md`; it authorizes no run or sensitive operation by itself.
- USD0 provider tests use local WAV/MP3, memory stores and disposable PostgreSQL. No real voice generation, checkout charge, ledger reset, QA privilege change, Premium/Grok or prohibited branch modification occurred.

## Reproduce offline

Install locked npm dependencies and local ffmpeg/espeak-ng/PostgreSQL tools. No production environment file is needed.

```sh
npm run test:resource-sentinel
node --import tsx --test src/lib/audio-studio/paid-supply-port.test.ts src/lib/audio-studio/render-fence.test.ts src/lib/supply/quality-readiness.test.ts scripts/mystery-shopper/quality-loop/sentinel-readiness.test.ts
PG_BIN="$(pg_config --bindir)" bash scripts/qa/audio-supply-db.sh /tmp/atomivid-disposable-audio-db 55633
node --import tsx --test src/lib/audio-studio/render.test.ts src/lib/audio-studio/transporte.test.ts src/lib/audio-studio/v4-turbo.test.ts
npx next typegen && npx tsc --noEmit
```

Use a NEW disposable directory each database run. The script creates its own Unix socket, disables TCP listeners, applies only local schema and stops that instance on exit. Logs and actual remote CI links accompany the delivery evidence; no compilation/deployment/schedule is simulated.
