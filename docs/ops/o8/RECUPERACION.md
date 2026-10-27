# O8: recuperación ante cancelación o resultado indeterminado

Este procedimiento vale para el run autorizado de `o8-ejecucion-unica.yml`. Se aplica cuando el run no termina con uno de estos dictámenes explícitos:

- **COMPLETADO**: pasos 4 y 5 en verde y resumen «O8 COMPLETADO».
- **REVERTIDO**: contingencia aplicada y estado previo exacto.
- **BLOQUEADO**: no se escribió nada, o O8 se deshizo y quedan cambios concurrentes de datos.

Ejemplos: run cancelado, runner perdido, timeout, error de red durante el paso 4 o fallo del paso 1 de la contingencia.

La herramienta aplica la 140000 y su fila de registro en **una sola transacción** (el archivo no tiene `begin/commit` propios), así que un corte durante el paso 4 deja el estado previo o el completado, nunca uno intermedio. Los estados parciales solo pueden venir de una intervención manual.

## Reglas

1. **No reintentar O8.** Esa autorización ya está consumida.
2. **No escribir en producción.** La primera acción es siempre solo de lectura.
3. **No tocar datos del estudio, `pi_*` ni jobs** para forzar la igualdad con el estado previo.
4. **El rollback auditado de la 140000 no es idempotente.** Sobre un estado sin la 140000 borraría `pi_supply_state`. La contingencia de `o8.sh` lo impide con una guarda: se niega si falta `pi_supply_state_pre_studio` o si hay filas del estudio. No ejecutar el rollback a mano.

## Pasos

1. **Clasificar en solo lectura.** Se ejecuta el workflow `o8-clasificar.yml` en esta rama, con el mismo SHA autorizado. Lanza `o8.sh snap` + `o8.sh classify` dentro de una transacción READ ONLY.
2. **Actuar según la clasificación:**

| Clasificación | Qué significa | Acción |
|---|---|---|
| `PRE` | Nada aplicado: cuerpos de 20261005150229, sin objetos de la 140000 y sin registro. | Reportar **BLOQUEADO** (sin cambios). Una nueva ejecución requiere una nueva autorización de Hans. |
| `COMPLETADO` | Estado posterior auditado: `o8.sh done` pasa (cuerpos, acceso por rol, RLS, libro del estudio vacío). | Reportar. Para O10 hacen falta además `o8.sh post` contra el `pre.snap` del run y `GATE_NEXT=DONE` 13/13. |
| `PARCIAL_SIN_REGISTRO` | Objetos de la 140000 presentes sin fila de registro (solo posible por intervención manual). | No registrar a mano. Requiere autorización de Hans para la contingencia auditada (guarda + paso 1 + paso 2). |
| `PARCIAL_SOLO_REGISTRO` | Fila de registro sin los objetos. | **No** ejecutar el rollback: la guarda lo rechaza porque borraría `pi_supply_state`. Requiere una decisión de Hans sobre retirar solo la fila; no hay paso automático. |
| `INDETERMINADO` | Cualquier otro estado: un cuerpo distinto del auditado, el paso 1 fallido a medias, O3 no completado… | Detener. No aplicar nada. Informar a Hans con el snapshot (solo digests) y esperar instrucciones. |

## Requisito para O10 (merge de #228)

O10 no se considera hasta que se cumplan las tres condiciones:

1. Un run de O8 sobre el SHA autorizado terminó **COMPLETADO**: paso 5 en verde y contingencia no ejecutada.
2. Una lectura nueva de producción pasa `o8.sh done`.
3. `GATE_NEXT=DONE` está 13/13.
