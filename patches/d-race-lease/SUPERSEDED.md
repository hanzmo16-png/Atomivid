# SUPERADO — no aplicar (T-20261019-1602, Grok)

Este parche de arrendamiento (lease) para D-RACE queda **superado** por el arreglo dentro del motor del ledger
(`src/lib/production-intelligence/ledger.ts`, commit 2ba3888 de PR #159). Motivo:

- Un lease vencido daba a un segundo llamador permiso para marcar/retomar la operación del ganador. Si el ganador era
  lento pero estaba legítimamente en vuelo, el lease **mutaba la operación del ganador** y podía conducir a un segundo
  envío — exactamente lo que el criterio de F1-A prohíbe («un lease nunca implica permiso para volver a pagar»;
  «el tiempo transcurrido por sí solo nunca prueba que el proveedor no cobró»).
- El arreglo del motor: el perdedor ve SUBMITTED y lanza `SubmissionInFlightError` **sin tocar la fila**; un SUBMITTED
  antiguo solo puede pasar a RECONCILIATION_REQUIRED por `flagStaleSubmission` (nunca a RESERVED, nunca reenvío), y solo
  `reconcileWithProviderEvidence` con prueba del proveedor lo cierra (COMMITTED o REFUNDED 0 con prueba no vacía).
- RED por mutación: `scripts/harness/adversarial/run-red.sh MUT=lease-repay` reintroduce la semántica del lease y la suite
  adversarial falla (18/4), ver dossier.

Se conserva el directorio solo como historial de la decisión.
