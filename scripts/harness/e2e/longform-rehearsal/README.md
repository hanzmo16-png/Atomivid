# Ensayo Long Form local (simulado, USD 0)

Material SINTÉTICO; no certifica calidad editorial ni proveedores reales. Credenciales del banco: cuentas locales de prueba generadas por `setup.sh` (no son secretos de producción).

1. Banco: `scripts/harness/e2e/infra/setup.sh` (PG17 + PostgREST + gateway + Next 3100 + worker-receiver). `seed-elevenlabs-local.sql` (topes locales).
2. Mock de proveedores: `mock-longform-providers.mjs` (puerto 54610; `FAULTS_FILE` → `{"pexels":{"mode":"503"|"empty","remaining":N}}`).
3. Worker: `worker-longform.ts` (solo loopback; claves falsas).
4. Recorrido: `TOPIC="…" TAG=R5 node e-run.cjs` (UI crear → guion inyectado SIN LLM por RPC → UI configurar/confirmar → worker → resultado/descarga). Reintento: `RESUME=1 BTN=Reintentar TAG=R5b node e-run.cjs`.
5. Economía antes/después: `./snap.sh <etiqueta> <requestId>` (ledger del pedido + contadores del log del mock).
6. Paquete: `node build-pkg-inputs.cjs <requestId> <dir>` → `scripts/av-qc.ts` → `scripts/youtube-package.ts`.
