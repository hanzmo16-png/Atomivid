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

## Siguiente paso
Subir el dossier final a Drive Entregas; que un humano revise antes de cualquier prueba beta.
