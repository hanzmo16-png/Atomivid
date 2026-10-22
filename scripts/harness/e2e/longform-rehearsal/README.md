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
