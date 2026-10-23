# Ensayo Long Form local (simulado, USD 0)

Material SINTÉTICO; no certifica calidad editorial ni proveedores reales. Credenciales del banco: cuentas locales de prueba generadas por `setup.sh` (no son secretos de producción).

1. Banco: `scripts/harness/e2e/infra/setup.sh` (PG17 + PostgREST + gateway + Next 3100 + worker-receiver). `seed-elevenlabs-local.sql` (topes locales).
2. Mock de proveedores: `mock-longform-providers.mjs` (puerto 54610; `FAULTS_FILE` → `{"pexels":{"mode":"503"|"empty","remaining":N}}`).
3. Worker: `worker-longform.ts` (solo loopback; claves falsas).
4. Recorrido: `TOPIC="…" TAG=R5 node e-run.cjs` (UI crear → guion inyectado SIN LLM por RPC → UI configurar/confirmar → worker → resultado/descarga). Reintento: `RESUME=1 BTN=Reintentar TAG=R5b node e-run.cjs`.
5. Economía antes/después: `./snap.sh <etiqueta> <requestId>` (ledger del pedido + contadores del log del mock).
6. Paquete: `node build-pkg-inputs.cjs <requestId> <dir>` → `scripts/av-qc.ts` → `scripts/youtube-package.ts`.

## Guion aprobado por el flujo editorial real (caso 839857e1 / 290de42b)

7. `OUT=…/approved-script.json npx tsx editorial-chain.ts` recorre `generateDocumentaryScript` con el borrador REAL del caso y un simulador determinista (escritor por fragmentos, revisor con catálogo, planificación visual) y comprueba `editorialApprovalError`.
8. `APPROVED_SCRIPT=…/approved-script.json REPO_DIR=$PWD JOB_ID` (lo pone `e-run.cjs`) usa `g-inject-approved.ts`: persiste ese guion por las RPC productivas `claim/finish_documentary_script_job`.
9. Voz elegida por UI (`VOICE_ID=…`): el Next del banco necesita `REEL_VOICE_SELECTION_ENABLED=true`; sin ella el selector no se muestra (el catálogo devuelve `enabled:false`) y la voz privada requiere `PRIVATE_VOICE_GRANTS=<voiceId>=<email>`.
10. Mismo dueño + mismo tema + misma duración devuelve el pedido ya existente (deduplicación): para otro ensayo cambia `TOPIC`.
11. Worker del banco hasta MP4 (solo local, claves falsas «local-fake-…», salida no-loopback rechazada por `worker-longform.ts`): `logs/worker-env-override.json` necesita `LONG_FORM_REAL_RUN_CONFIRM` (la guarda de modo real del orquestador; nunca en producción ni en CI), `IMAGE_PROVIDER=openai` + `OPENAI_API_KEY=local-fake-openai` y `MUSIC_PROVIDER=curated-library` con las pistas del manifiesto copiadas (sintéticas) en `storage/music-library/`. Sin ellas el worker se detiene correctamente con «modo real sin confirmación» o «proveedor resolvió a fixture».
12. El mock de Recraft devuelve la proporción pedida (`landscape_16_9` 1824x1024, `portrait_16_9` 1024x1824); antes devolvía 1536x1024 y el control automático de imagen (16:9 ±3 %) lo rechazaba con razón.
