# Auditoría independiente de PR #161 (Codex, D-RACE) — Grok, T-20261019-1602

- PR #161 `codex/d-race-readonly-reconciliation-20261019`, HEAD `fb5e6fa`, base `grok/reel-money-precision-e2e-20261019` (PR #157). DRAFT.
- No se editó la rama de Codex. Auditoría en worktree temporal (`git worktree add … pr161`).
- Mi reclamo de D-RACE (16:10) es anterior; mi arreglo está en PR #159 (commit 2ba3888, sobre PR #158).

## Qué cambia PR #161
1. Añade `SubmissionInFlightError extends ReconciliationRequiredError` (mismo nombre y jerarquía que el de PR #159).
2. Un observador que ve `SUBMITTED` lanza `SubmissionInFlightError` **sin reescribir la fila** (antes la pasaba a RR y envenenaba el CAS del ganador).
3. Tests: `ledger-race.test.ts` (unitario, memoria), ajuste de `scripts/harness/ledger-race.pg.test.ts` y `draft-idempotency.test.ts`.

Ese núcleo es **idéntico** a la primera parte de mi arreglo. Es correcto y seguro con el dinero: ningún segundo envío, ninguna mutación de la operación del ganador.

## Validación en PG local real (mi suite adversarial 2/5/10, esquema clonado de `atomivid`, RPC `pi_submit_with_supply` real)
Comando: worktree de PR161 + `scripts/harness/adversarial/ledger-adversarial.pg.test.ts` (import adaptado: funciones ausentes ⇒ fallo explícito) + `run.sh`.
Resultado: **12 pass / 10 fail** (log `adv-pr161.log` en el dossier).

| Test | Resultado en PR161 | Causa |
|---|---|---|
| concurrencia feliz 2/5/10 | FAIL | los perdedores que pierden el CAS RESERVED→SUBMITTED reciben `ReconciliationRequiredError` genérico, no «en curso»: no distingue en vuelo de incierto (criterio F1-A.1). Sin envío doble ni mutación. |
| respuesta perdida 2/5/10 | FAIL | no existe `reconcileWithProviderEvidence`: un RR no tiene salida basada en evidencia del proveedor (criterio A.4/A.5 sin camino). |
| caída antes del envío 2/5/10 | FAIL | no existe `flagStaleSubmission`: un SUBMITTED huérfano queda en SUBMITTED para siempre (bloqueado, sin alerta de conciliación). |
| ganador marcado huérfano a mitad | FAIL | sin marca explícita, el caso no existe; si se marcara RR por otro medio, el ganador perdería su job (el CAS SUBMITTED→PJR falla y PR161 no liquida desde RR). |
| 429 / timeout / 5xx / moderación, saldo insuficiente 2/5/10, UNKNOWN/DOWN/stale, bloqueo por RR, numeric(12,4), egreso | PASS | comportamiento heredado de la base, igual que en #159. |

## Por qué el arreglo de #159 es distinto (y un superconjunto)
- Pérdida del CAS RESERVED→SUBMITTED ⇒ `SubmissionInFlightError` (en vuelo legítimo), no RR genérico.
- El ganador, si su fila fue marcada RR, anota `providerJobId` sobre la fila RR (el trigger forward-only prohíbe RR→PJR) y liquida desde RR: el pago no se pierde.
- Fallo del CAS de COMMIT ⇒ relectura; solo devuelve la fila si es COMMITTED con el mismo job.
- `flagStaleSubmission` (SUBMITTED antiguo → RR, nunca RESERVED, nunca reenvío) y `reconcileWithProviderEvidence` (accepted / committed / not_charged con prueba no vacía). El tiempo solo nunca cierra nada.

## Recomendación (decisión de Hans)
No hay duplicado conflictivo en concepto: #161 ⊂ #159. Sí hay conflicto textual (mismo `ledger-race.test.ts`, mismo bloque de `ledger.ts`). Opciones: (a) cerrar #161 como subsumido por #159; o (b) integrar #161 primero y rebasar #159 encima (el diff de #159 queda en los añadidos listados). No apruebo ni fusiono ninguno.
