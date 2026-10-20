# PROGRESO F40 — Operación Ferrari F40 (PR #159)
Actualizado: 2026-10-19 ~18:35 (America/Cancun, UTC-5). Claim T-20261019-1602-hans-01.

## Árbol (verificado con `git merge-base --is-ancestor`)
- PR159 grok/reel-rc-f40-20261019, evidencia medida en HEAD df49abf
- base PR158 chatgpt/reel-retry-budget-review-20261019 @a8a3955 (sin cambios, es ancestro)
- PR157 @9fd5bb4 → PR154 @a761b01 → PR151. Producción de referencia 35fb212.
- PR161 (Codex) auditado (docs/harness/F40-PR161-auditoria.md); NO se aplicó cherry-pick: #159 ya cubre D-RACE y toca los mismos 4 archivos. ChatGPT QA-1750 recomienda cerrar #161.

## Hecho (en df49abf)
- F1 suite adversarial en PG 17 real efímero (2/5/10 clientes): 22/22 GREEN. Controles RED por mutación: baseline 7 fallos, lease-repay 4, no-cas-check 1 (cada uno detectado).
- numeric(12,4): test de fronteras en ledger real GREEN.
- tsc exit 0; eslint --quiet exit 0; test:spend 293/293; test:unit 1970 pass / 6 fallos, los 6 YA fallan en la base a8a3955 (recovery-flow x2, attempt-state x3, avatar/recovery x1) → no son regresiones de #159.
- F2/F3/caos/a11y: ver commits e474cfb..df49abf y dossier.
- Limpieza __pycache__: ya no está versionado; .gitignore tiene __pycache__/ y *.pyc.

## Pendiente / límites
- GitHub Actions: NO hay ejecuciones para df49abf (sólo Vercel). No se afirma CI verde.
- Volcado de filas del ledger: la suite afirma sobre filas reales (estado, importes, conteo de envíos), pero no exporta CSV.
- RPC de suministro real: no se ejecuta; esquema por migraciones en PG local, proveedores simulados, sin salida a proveedores reales.
- 6 tests unitarios preexistentes en rojo en la base (fuera de alcance).

## v2 (2026-10-19 ~19:30 America/Cancun) — cierre de brechas en df8c7d4 → HEAD
- Re-verificado en df8c7d4 (Node 22.23.3): test:unit 1976/1976, test:spend 293/293, tsc 0, eslint --quiet 0, next build 0.
- Adversarial PG17 2/5/10: 22/22 GREEN; RED baseline 7, lease-repay 4, no-cas-check 1 (detectados). CSV exportado (ledger_ops 27 filas, ledger_transitions 80).
- Diagnóstico de los 6 tests: NO es defecto del código. (a) attempt-state x2/x3: la prueba no era hermética; claim() usa la RPC pi_claim_render_supply si isProductionRuntime()||SUPPLY_GUARD_ENFORCED=true y la shell las heredaba (NODE_ENV=production tras build/arnés). Reproducido en a8a3955 y HEAD. Arreglo: la prueba fija el entorno y añade un caso que exige la ruta RPC (dueño+intento, error visible). Pasa con NODE_ENV=production, VERCEL=1, SUPPLY_GUARD_ENFORCED=true. (b) avatar/recovery «historial» x1: prueba obsoleta frente al contrato PR158 (a1b5994). (c) recovery-flow x2: no reproducible en Node 20.19.2 ni 22.23.3 sobre a8a3955 ni HEAD; .nvmrc=22 lo fija.
- GitHub Actions: no hay disparador push/pull_request para esta rama/base; se usó workflow_dispatch de e2e-fixture-evidence (sin secretos, contents:read, proveedores fixture) con sha=df8c7d4: run 39346075525.

## Siguiente paso
Subir el dossier final a Drive Entregas; que un humano revise antes de cualquier prueba beta.

## v3 (2026-10-19 ~20:15 America/Cancun) — fuga de BDs adv_* corregida
- scripts/harness/adversarial/run.sh: se quitó `exec node` (reemplazaba la shell y el trap EXIT nunca corría → 23 BDs adv_* filtradas en el PG17 local, ya borradas). Ahora node corre como hijo y se conserva su código de salida; restauración del esquema con ON_ERROR_STOP=1 (sin `|| true`).
- Prueba: lista de BDs antes/después de la suite GREEN idéntica; tras GREEN+CSV y los 3 RED (que salen ≠0) quedan 0 adv_*.
- PG17 2/5/10: 22/22 GREEN; RED baseline 7, lease-repay 4, no-cas-check 1 (detectados). CSV: ledger_ops 27 filas, ledger_transitions 80.
- Node 22.23.3: tsc 0, eslint --quiet 0, test:spend 293/293, test:unit 1977/1977. Los 6 tests históricos (recovery-flow, attempt-state, avatar/recovery: 14 casos en esos 3 archivos) pasan también con NODE_ENV=production VERCEL=1 SUPPLY_GUARD_ENFORCED=true.
- Nota: test:unit completo con ese entorno hostil da 74 fallos en otros archivos (selección de proveedores fixture vs producción); es comportamiento esperado de producción, no se tocó.
- Evidencia: /workspace/tmp/f40-evidence/<HEAD>/ (en la caja del agente).

## v4 (2026-10-19 ~21:45 America/Cancun) — F3, arnés if: failure(), F2 en BD nueva
- F3 (director-fire-e2e.cjs, f40v3 sobre 3b493f0 + cambios de arnés SIN COMMIT): 83 PASS · 2 FAIL. short30 27/27, long60 27/27, uneven90 27/27, imgx30 1 PASS/2 FAIL (503 tope de gasto OpenAI + 0 llamadas de relleno, consecuencia). Egreso: 0 salidas reales (3 intentos bloqueados).
- Diagnóstico del 503 («2.00 USD necesarios»): configuración/seed, NO defecto. seed-config.sql fija openai daily_cap 5 / monthly 20 USD; la BD de f40v3 acumulaba 4.28 USD (gasto mock) de los escenarios previos en la misma BD → 4.28+2.00 > 5 ⇒ readiness.ts marca correctamente «provider funded spend ceiling». En BD nueva (gasto 0) F2 D2/D3 pasan.
- Arnés (commit 4a08238): worker-receiver.mjs emula el paso `if: failure()` de render.yml (mark-render-failed.ts tras salida ≠0/SIGKILL); worker-images.ts escribe .render-attempt.json como worker-cli.ts; start.sh aborta si los puertos fijos están ocupados por otro checkout; .render-attempt.json en .gitignore. Revisado: correcto, se conserva.
- F2 (reel-images-e2e.cjs) en 4a08238, BD nueva: 30 PASS · 0 FAIL (exit 0). RED: 26 PASS · 4 FAIL (exit 1, detectado: D1 tope de material).
- Evidencia: /workspace/tmp/f40-evidence/3b493f0/f3-f40v3/, /workspace/tmp/f40-evidence/4a08238/f2/.

## v5 (2026-10-19 ~22:50 America/Cancun) — aislamiento del arnés F3, F3 en BD nueva, RED
- Defecto de arnés (v4) corregido en 4b555b0/79ae7d4: antes de cada escenario `resetSpendBaseline` archiva (f3/fire-harness-spend-reset.jsonl) y borra el ledger mock local (pi_paid_operations append-only ⇒ `session_replication_role=replica` sólo en esa transacción; también pi_supply_job_reservations), siembra la base pedida y exige que pi_supply_spend la refleje (check por escenario). Se eligió reiniciar el gasto mock, no BD por escenario. El tope del producto (seed 5 USD/día) NO se tocó.
- Escenario nuevo capx30: base 4.28 USD openai COMMITTED hoy + 2 USD pedidos ⇒ exige 503 con error humano (sin HTTP/rutas/op_), solicitud sigue en script_ready, 0 llamadas a imágenes y 0 operaciones openai.
- Defecto de setup.sh corregido: la marca 0023.done vivía en $E2E_HOME/run y sobrevivía a una BD nueva (fallaba la migración provider_supply_controls); ahora vive en $PGDATA.
- F3 en 79ae7d4, BD nueva (`E2E_SCRIPT=director-fire-e2e.cjs run-e2e.sh f3`): 117 PASS · 0 FAIL, exit 0. short30 28/0, long60 28/0, uneven90 28/0, imgx30 28/0 (2 llamadas de imagen = ops COMMITTED), capx30 4/0. Egreso: 0 salidas reales (5 intentos bloqueados).
- RED media_qa (`qa-red/run-qa-red.sh <final.mp4> <director.json> <dur> <out>`) sobre los 4 MP4: 12/12 mutaciones detectadas en cada uno (rc 0).
- Evidencia: /workspace/tmp/f40-evidence/79ae7d4/f3/ (la corrida 4b555b0 con 116/1 por cuerpo truncado en el arnés: f40-evidence/4b555b0-superseded/).
- Caos (`E2E_SCRIPT=reel-chaos-e2e.cjs run-e2e.sh chaos`) en c779734, BD nueva: 51 PASS · 0 FAIL, exit 0. X1 voz 9/0, X2 img500 8/0, X3 img429 8/0, X4 respuesta perdida 9/0, X5 storage 8/0, X6 SIGKILL 8/0; egreso 1/1 (8 intentos rechazados, registry.npmjs.org). Evidencia: /workspace/tmp/f40-evidence/c779734/chaos/.
- Servicios detenidos tras las corridas. CI: ver commit siguiente / reporte.
