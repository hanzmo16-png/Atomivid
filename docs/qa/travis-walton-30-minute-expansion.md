# Thirty-minute expansion — preparation checkpoint

The owner clarified that the agreed episode is 30 minutes. Version 4 is a verified
13:33.92 short edit, not completion of that duration requirement. Preserve it.

An additional eight-section Spanish script is prepared (2,395 words / 15,644
characters). Its private text is encrypted in `ops/travis-walton/expansion.json.sealed`.
It adds investigation, source distinctions and attributed objections at existing
chapter boundaries. Retain the original narration and four avatar interventions.
Codex prepares the inputs; Grok remains responsible for rendering and publishing.
The editor account remains exclusive to Grok and has not been used here.

## Authorization and remaining daily-quota wait

Run 38023094677 stopped in preflight, before any paid provider call:

- Existing voice ledger valuation: USD 2.4424.
- Additional voice estimate: USD 3.1288 (15,644 characters at USD 0.0002).
- Existing episode voice cap: USD 4.00, unchanged.
- Total required voice envelope: USD 5.5712; rounded proposed cap USD 5.58.

Hans authorized the USD 5.58 total voice cap on 2026-10-09 at 23:13 Cancun.
The encrypted expansion plan and `expand-voice.ts` now enforce that exact cap;
all provider/global limits remain unchanged.

Run 38023380081 generated x01 (118.746 s) and x02 (123.205 s) and stored them
immutably. The ledger confirms two new COMMITTED operations totaling USD 0.7002,
one RESERVED operation (x03, not submitted), and no uncertain operations.
It stopped because ElevenLabs reached 14/14 daily calls. The configured timezone
is America/Cancun; the next daily window starts 2026-10-10 00:00 local / 05:00 UTC.
Do not raise or bypass that quota. Resume after the daily window resets.

The resume envelope now counts an exact pending pre-submit reservation once,
using the same voice fingerprint as the paid-call adapter. Existing audio is
reused. Six blocks and the real 30-minute duration validation are still pending.

## Resume after authorization

1. Confirm the daily request quota has reset; preserve all other caps.
2. Change the comment in `ops/travis-walton/mode`, retaining first line
   `close-narrate-30`, to trigger the workflow on this branch. Run the encrypted
   expansion through `expand-voice.ts`, reusing its stable paid
   fingerprints and immutable per-block receipts on retries.
3. When narration completes, set mode `close-prepare-30`. This calls
   `prepare-30.ts`, `owner_inputs_30.py` and `build_30_inputs.py`. It fetches v4
   through an owner session, downloads new voice/music and 20 free stock clips,
   measures decoded audio, and prepares an exact 1,800-second mix, word timings,
   20 chapters and matching moving visuals. It rejects a voice tempo adjustment
   outside 0.90–1.12 and requires inter-word silence at every insertion. Original
   PCM and four avatar cuts remain in order. No final episode video is rendered.
4. Fetch complete stock files and decode every media source before publication.
5. Inspect the encrypted `thirty-preparation-report.json`, `thirty-montaje.json`,
   `thirty-stock-sheet.jpg` and voice sample under the run ID on branch
   `travis-sealed-out`. The current export private key is in the task's private
   scratch folder; if unavailable, generate a new export keypair and re-export
   through CI. Never expose private narration or media in this public repository.
   Fix any media/semantic issues before publication.
6. Store the reviewed manifest hash in `ops/travis-walton/approved-input-sha256`.
   Create a scoped, short-lived owner v5 `escribir_entrada` assignment and an editor
   v5 `leer_entrada,escribir_salida,escribir_estado` assignment. Confirm no v5
   conflict. Set mode `close-publish-30`; it deterministically rebuilds inputs,
   requires the reviewed hash, verifies every object and writes LISTO.json last.
   Revoke the temporary producer assignment afterwards. Sessions close in finally.
7. Hand the complete verified package to Grok for render and output publication.
8. Verify the resulting COMPLETO.json and playback in the owner's app session.

At this checkpoint the new preparation code has syntax/type checks only; the
real media integration must run after the remaining voice blocks exist. The
repository has a pre-existing generated-type error in app/layout.tsx (LayoutProps).
Do not report that the new package has already passed media validation.

The independent platform closure remains with Claude. This branch changes only
episode preparation scripts and documentation, not the platform production flow.
