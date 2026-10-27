# O2: recuperación ante cancelación o resultado indeterminado

Este procedimiento vale para el run autorizado de `o2-ejecucion-unica.yml`. Se aplica cuando el run no termina con uno de estos dictámenes explícitos:

- **COMPLETADO**: pasos 4 y 5 en verde y resumen «O2 COMPLETADO».
- **REVERTIDO**: contingencia aplicada y estado previo exacto.
- **BLOQUEADO**: no se escribió nada, o O2 se deshizo y quedan cambios concurrentes.

Ejemplos: run cancelado, runner perdido, timeout, error de red durante el paso 4 o fallo del paso 1 de la contingencia.

## Reglas

1. **No reintentar O2.** Esa autorización ya está consumida.
2. **No escribir en producción.** La primera acción es siempre solo de lectura.
3. **No tocar jobs ni datos `pi_*`** para forzar la igualdad con el estado previo.

## Pasos

1. **Clasificar en solo lectura.** Se ejecuta el workflow `o2-clasificar.yml` en esta rama, con el mismo SHA autorizado. Lanza `o2.sh snap` + `o2.sh classify` dentro de una transacción READ ONLY.
2. **Actuar según la clasificación:**

| Clasificación | Qué significa | Acción |
|---|---|---|
| `PRE` | Nada aplicado. Los cuerpos, el ACL y el trigger son exactamente los de PR198 y la 120000 no está registrada. | Reportar **BLOQUEADO** (sin cambios). Una nueva ejecución requiere una nueva autorización de Hans. |
| `COMPLETADO` | Estado posterior auditado: `o2.sh done` pasa. | Reportar. Para considerar O3 hacen falta además `o2.sh post` contra el `pre.snap` del run (o una relectura) y `GATE_NEXT=O3` 16/16. Si no se dispone del snapshot previo, ejecutar el ensayo en réplica sobre el estado actual antes de dar O2 por completado. |
| `PARCIAL_SIN_REGISTRO` | El SQL quedó confirmado y falta la fila del registro. Es la ventana entre el `commit` del archivo y el `insert` de la herramienta. | No registrar a mano. Requiere autorización de Hans para la contingencia auditada (paso 1 + paso 2), con verificación `o2.sh same` / `verdict`. |
| `PARCIAL_SOLO_REGISTRO` | Hay fila en el registro pero los cuerpos son los de PR198. | Requiere autorización de Hans para el paso 2 de la contingencia (que retira la fila). Verificar con `o2.sh same`. |
| `INDETERMINADO` | Cualquier otro estado, por ejemplo después de que fallara el paso 1 de la contingencia, o un cuerpo distinto del auditado. | Detener. No aplicar nada. Informar a Hans con el snapshot (solo digests) y esperar instrucciones. |

## Requisito para O3

O3 no se considera hasta que se cumplan las tres condiciones:

1. Un run de O2 sobre el SHA autorizado terminó **COMPLETADO**: paso 5 en verde y contingencia no ejecutada.
2. Una lectura nueva de producción pasa `o2.sh done`, con las referencias auditadas de los cuerpos, atributos, ACL, la definición completa del trigger y el registro 64/1.
3. `GATE_NEXT=O3` está 16/16.
