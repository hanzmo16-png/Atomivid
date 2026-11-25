# Mystery Shopper 3.0: ejecución real de YouTube (Long Form), 2026-11-25 (hora Cancún, UTC-5)

Cuenta QA en producción (dpl_BLQetKFDMvdVm7qmXz5fGB74uEXG, 9ed20e7f). Tema: nubes y lluvia, 3 min, español.

## 1. Guion: fallo técnico 1091fe88 (intento 1)
- Etapa: «Comprobando la primera recompensa de la apertura» (`editorial-opening-repair.ts`).
- Log: `[atomivid:script-job:1091fe88:schema] ["unrecognized_keys@firstAnswer.evidence"]`.
- Causa confirmada: la respuesta de reparación traía una clave extra dentro de `firstAnswer.evidence`. Por contrato, `dropVerifiedEvidenceEchoes` solo quita los ecos verificados de `quote`/`beatIndex`, y `RepairSchema` es estricto, así que el rechazo técnico es el comportamiento diseñado (prueba `editorial-rescue-audit.test.ts`: allow-list por contrato).
- Sin confirmar: el nombre de la clave. El log no lo registraba.
- El botón «Reintentar (reutiliza lo ya guardado)» reutiliza la respuesta ya pagada, así que el reintento falla siempre igual. Para el cliente es un callejón sin salida.
- Gasto: 4 operaciones de anthropic en estado COMMITTED (`pi_paid_operations`) = USD 0.2243.
- Intento 3 (otro tema): el guion terminó bien. La app mostró USD 0.27 y `pi_paid_operations` registra 8 operaciones por USD 0.2675.

### Arreglo en esta rama (sin cambio de política)
1. `schemaIssuePaths` añade los NOMBRES de las claves no reconocidas (nunca sus valores), así: `unrecognized_keys@firstAnswer.evidence[note]`.
2. El prompt de reparación pide que evidence sea EXACTAMENTE `{"excerptId": "<id>"}`. Esto ataca la causa probable sin relajar el contrato.
3. Pruebas de regresión en `editorial-opening-repair.test.ts`.

### Decisión pendiente (Hans o el responsable editorial)
Opción: que una clave extra que no contradice el veredicto se trate como observación editorial (delivered=false, nunca aprueba) en lugar de fallo técnico terminal. Esto cambia una prueba de auditoría existente, así que no se incluye sin aprobación.

## 2. Techo del render: USD 8.04 para un video de 3 min
- Desglose: «Render (peor caso)» USD 5.94 = `MAX_RENDER_ATTEMPTS` 3 × `LONG_FORM_RENDER_JOB_TIMEOUT_MIN` 330 × USD 0.006/min. Después «Subtotal» 6.70 × 1.2 de contingencia = 8.04.
- El techo es honesto respecto a `render.yml` (timeout fijo de 330 min para cualquier long_form), pero para un video de 3 min es unas 16 veces el costo estimado de proveedores (USD 0.49). Cualquier tope de cliente o de QA razonable lo bloquea.
- Los dos renders reales tardaron menos de 2 min de runner (GitHub Actions 45527071098: 1 min 50 s; 45528103117: 1 min 44 s).
- Arreglo propuesto (necesita el scope `workflow` y el OK de Hans): pasar `timeoutMinutes` escalado por duración en el `client_payload` del dispatch y usarlo en `render.yml` (`timeout-minutes`), y calcular `longFormRenderCeilingUsd(duración)` con el mismo valor. Sin el cambio en el workflow, bajar el techo en la app lo dejaría por debajo del peor caso real, así que no se hace por separado.

## 3. Render detenido antes de gastar por falta de material (bloqueante real)
- «Económico / archivo»: `912ae633`, 14 escenas sin material pertinente y único. Equilibrado: `2bfc8545`, 12 escenas. En los dos casos la app dice «No se ha llamado a ningún proveedor de pago (USD 0)»; verificado, porque no hay operaciones nuevas en `pi_paid_operations`.
- Configurar mostraba «43 recursos de archivo» (Económico) sin avisar de la falta de cobertura: la vista previa de costo y plan promete un plan que el worker no puede cumplir.
- «Equilibrado» debería cubrir con imágenes IA donde el archivo no alcanza, y aun así se detuvo por falta de archivo.
- Causa raíz: SIN CONFIRMAR. Hace falta revisar por qué el preflight de Configurar no ejecuta la misma comprobación de material que el worker y por qué Equilibrado no sustituye por imágenes IA.
- «Cinemático / IA» (estimado USD 2.24) supera el tope de USD 2 del módulo: no se probó.
