# Reel voice selection — isolated rollout

Prepared on 2026-10-20 from production baseline `4bee0d3ea0e3c4d5971e659db7942e18f7da76ce`.
This change is not a production deployment or a completed real-provider acceptance test.

## Customer behavior

- The existing language default remains selected. Leaving it selected preserves the old request identity and provider behavior.
- With `REEL_VOICE_SELECTION_ENABLED=true` on the web, Reels offer up to three additional available voices with existing provider audio previews. Listening does not call speech synthesis.
- Choices come from the configured ElevenLabs account: premade voices plus the two public Library IDs already approved in the repository (Mateo and Víctor). Private clones are excluded from additional choices. Native language is prioritized; multilingual alternatives may have a preview in another language, disclosed in the UI. Availability and sample playback still require live acceptance.
- A language change clears the previous selection. Switching to Avatar removes the Reel picker and its form field.
- A catalogue outage leaves the default path usable. An explicit invalid/unavailable selection is rejected before creating a request; it is never silently replaced.

## Persistence and charging

The server validates the choice, includes it in the canonical submission intent, and saves it in the nullable `video_requests.reel_voice_id` column. Script edits/regeneration do not overwrite it. A trigger makes the value immutable after creation, including for service writers. Existing rows remain NULL.

The worker passes this value only to the Reel pipeline. `reelNarration` binds the same ID to both the ElevenLabs adapter and the paid-result identity. The existing ledger, speed-correction bound, total budget and render pipeline remain authoritative. No changes to the visual selector or paid-call gate.

## Verification performed locally

- Unit suite: 2,003 passed; spend suite: 300 passed.
- Final focused tests after normalization/UI rollout adjustment: 47 passed.
- `next typegen`, TypeScript and ESLint on changed TypeScript/TSX source passed. The repository excludes `.mjs` scripts from ESLint; those supplemental scripts were executed directly.
- Real ElevenLabs adapter with intercepted HTTP: selected ID matches the actual request URL; duplicate requests reuse stored audio; speed correction keeps the same voice; a different voice cannot reuse another voice's audio; legacy default remains consistent. No external synthesis.
- `node scripts/verify-reel-voice-action.mjs`: actual server action and GET route with synthetic auth/DB and provider GET. Selected voice persistence, stable resubmission, default compatibility, invalid/disabled rejection and unauthorized access tested.
- `scripts/verify-reel-voice-ui.mjs`: actual NewVideoForm in Happy DOM, including select/change events, submitted FormData, language reset, preview failure, catalogue failure, flag off and Avatar isolation. This is not a real-browser playback test.
- `scripts/verify-reel-voice-selection.mjs`: additive migration executed in PostgreSQL WASM with synthetic rows. Existing NULL, immutable selection after script edit, mode/ID constraint, server-only writes and function permissions checked. This is not a hosted Supabase schema validation.

Reproduce supplemental checks without changing application dependencies:

```sh
npm install --prefix /tmp/voice-qa --save-exact @electric-sql/pglite@0.5.10 happy-dom@21.0.4
PGLITE_MODULE=/tmp/voice-qa/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-reel-voice-selection.mjs
HAPPY_DOM_MODULE=/tmp/voice-qa/node_modules/happy-dom/lib/index.js node scripts/verify-reel-voice-ui.mjs
node scripts/verify-reel-voice-action.mjs
```

## Release order and outstanding acceptance

1. Review the draft and CI, including overlap with Grok's visual-selector branch (`generate-video.ts`, `feature-flags.ts`, `package.json` may be shared).
2. Apply `20261020200444_reel_voice_selection.sql` before deploying the new worker. It adds a nullable column and trigger; no existing voice is changed. The new worker's SELECT requires that column even with the picker disabled. Do not deploy the worker before this migration.
3. Deploy the matching worker and web version with selection disabled; check an existing/default-voice Reel. Old workers must not receive custom-voice requests.
4. Enable the web flag in the controlled pilot. The worker deliberately honors a persisted selection without depending on this flag, so disabling the UI cannot change queued jobs.
5. Confirm live catalogue availability, named samples on Hans's phone, and a real Reel using a non-default voice from create → script review → render → play → download. Verify the voice in the provider operation and in the audio, total spend and retry reuse. Do not mark complete based on fixture results. No real-generation spend is authorized by this document.

To stop new selections, disable the web flag and redeploy that configuration. Keep the new worker/column until queued custom-voice jobs finish or are explicitly cancelled. Reverting the worker early would ignore the stored choice. Keep the additive column and trigger on rollback; dropping them is unnecessary and destroys intent.

Prepared only: no production migration, flags, merge, deploy, balances or existing requests changed; generation spend USD 0.

## Voces privadas (clones) — p. ej. «El Duro» (`duro hans`)

- Los clones que la cuenta de ElevenLabs posee (`category` `cloned` o `professional` con `is_owner: true`) son **privados**:
  solo se muestran y aceptan para las cuentas confirmadas a las que el servidor se los concede.
- Configuración de servidor (no es un secreto, pero no vive en el código):
  `PRIVATE_VOICE_GRANTS="<voiceId>=<email>[|<email>];<voiceId2>=<email>"`.
  Para El Duro: `PRIVATE_VOICE_GRANTS=CeFSZuaHs4SxcBxb9nCr=hanzmo16@gmail.com` (Production en Vercel).
- Requisitos: `REEL_VOICE_SELECTION_ENABLED=true`; la voz debe estar entrenada para `eleven_multilingual_v2`
  (`high_quality_base_model_ids` o `fine_tuning.state`). Si no, no se ofrece.
- El Duro no tiene `preview_url` en el proveedor: la UI dice «Sin muestra gratuita» y **no** genera muestras (costaría créditos).
- El mismo filtro se aplica al catálogo y a la creación de Podcast (antes listaba todos los clones a cualquier usuario beta).
- Diagnóstico gratuito: workflow `diag-elevenlabs-voices.yml` (GET /v1/voices; imprime id/nombre/categoría y compatibilidad; nunca la clave ni URLs de muestras).

### Revisión PR167

- La preferencia local se separa por cuenta autenticada e idioma; no se importa la antigua clave compartida.
- La compatibilidad del catálogo se comprueba con el modelo configurado en el adaptador de narración.
- Regresiones reproducidas antes de corregir: preferencia privada visible al cambiar de cuenta en el mismo navegador y rechazo de un clon compatible con un modelo configurado distinto.
