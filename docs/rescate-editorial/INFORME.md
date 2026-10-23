# Operación rescate del motor editorial — informe independiente (Grok)

> **Actualización «CIERRE DEFINITIVO PR #191» (2026-10-23):** la sección 12 sustituye a lo que contradiga en las secciones 4, 8, 9 y 10 (R2 genérico retirado, capa C limitada a contenido, umbral 60 %).

Fecha: 2026-10-23 · Rama: `grok/rescate-motor-editorial` (base `e68da2b`, producción con #188) · PR borrador, sin merge ni despliegue.

## 1. Diagnóstico de causa raíz (en palabras simples)
El motor pide al modelo muchos "mini-formularios" JSON que solo están descritos en el prompt (sin gramática del proveedor) y los valida con esquemas `.strict()`. **No existe una capa que separe la FORMA de la respuesta de su CONTENIDO**: cualquier ruido de forma en una comprobación auxiliar se trata como fallo técnico terminal y destruye un guion válido y pagado. Además, el **reintento reproduce la misma respuesta guardada con el mismo validador**, así que reintentar nunca puede salir bien: es un callejón sin salida determinista.

En el incidente, la comprobación «primera recompensa de la apertura» respondió correctamente (delivered=true, fragmento elegible `…:b0:w132`, explicación de 565 caracteres) pero añadió `firstAnswer.evidence.explanation: ""`. El esquema estricto lo rechazó → «La respuesta no cumple el formato editorial requerido».

## 2. Evidencia técnica
**Datos reales (SELECT de solo lectura vía Supabase MCP):**
- `23d86d0a` y `8c330c37` son **el mismo job** `e8048599` (EN, 15 min, `catalog-v1`, `fragments-v1`, tema Leonidas vs Attila). `error_code` es aleatorio por fallo (`randomUUID().slice(0,8)` en `script-jobs.ts`); `retry_count=2` → 3 ejecuciones, misma etapa «Comprobando la primera recompensa de la apertura», último fallo 2026-10-23 16:15 UTC (11:15 hora de Cancún), **después** del despliegue de #188 (13:42 UTC).
- Ledger `pi_paid_operations` del proyecto: **5 respuestas COMMITTED, todas de 14:46–14:50 UTC; 0,2781 USD**. Los reintentos no generaron llamadas nuevas (reutilizaron lo guardado) y fallaron igual → prueba de que el reintento es determinista.
- Borrador real persistido (`editorial_checkpoint`, pass 0): 10 bloques, 2016 palabras (~806 s; dentro de tolerancia para 900 s). Guardado como fixture `src/lib/video/long-form/__fixtures__/incident-e8048599-draft.json` (sin user_id ni campos de formulario; fuentes reducidas a IDs).
- Hallazgo nuevo con el borrador real: `creativeDirection.protectInEdit[2]` es una **paráfrasis** de la narración del bloque 2 (comparte 15 palabras literales consecutivas). En `e68da2b` eso habría bloqueado el guion entero como «necesita más trabajo editorial» aunque la apertura se hubiera aceptado.

**No verificable por mí:** el texto crudo de las 5 respuestas vive en Storage (`videos/.../paid/op_*.script.json`) y no es legible por SQL; no usé claves de servicio. La forma exacta de la respuesta del incidente se toma del análisis de PR #190 sobre el ledger real. El script `scripts/rescate-replay-incident.ts` permite confirmarlo sin coste (ver §6).

**Referencias de código (e68da2b):**
- `editorial-opening-repair.ts:8` `RepairSchema` con `.strict()` en tres niveles; `:52` `parseDocumentaryResponse` → `json-response.ts:validateDocumentaryValue` lanza el mensaje del incidente.
- `narration-catalog.ts` `LenientReferencedReviewSchema`: el crítico principal **ignora** claves extra en la evidencia (quote, beatIndex…), la reparación las **rechaza**. Contradicción interna.
- Prompt de la reparación: «explica la carencia **usando un fragmento elegible**» + `originalFirstAnswer` en forma tolerante → induce a poner una explicación dentro de `evidence`. Contradicción prompt ↔ validador.
- Historial de parches por síntoma: `editorial-json.ts` (un `]` huérfano), `editorial-function-repair.ts` (etiqueta fuera de contrato), #188 (anclas y cierre), #190 (claves vacías).

## 3. Hipótesis (1–7)
| # | Hipótesis | Veredicto | Evidencia |
|---|---|---|---|
| 1 | Estructura demasiado rígida | **Confirmada** | Contratos solo-prompt + `.strict()`; «No … extra keys» en `jsonResponseSystem`. |
| 2 | Contradicción prompt ↔ validador | **Confirmada** | Crítico tolerante vs reparación estricta; el prompt induce `evidence.explanation`. |
| 3 | Contenido correcto rechazado por forma | **Confirmada** | Respuesta del incidente correcta; marca de edición parafraseada bloquea un guion válido. Prueba `editorial-rescue-repro.test.ts` falla en e68da2b con el mensaje exacto. |
| 4 | Demasiados requisitos en una generación | **Parcial** | El escritor produce narración + 7 ángulos + 3 finalistas + 3 marcas literales; las marcas fallan. No es la causa del incidente. |
| 5 | Calidad narrativa mezclada con formato | **Confirmada** | Literalidad de metadatos de edición → `EditorialQualityError`; fallo de forma en la verificación de apertura → fallo técnico terminal en vez de observación editorial. |
| 6 | Recuperación reprocesa mal lo guardado | **Confirmada (como inútil, no corrupta)** | Reintento = mismo input, misma respuesta, mismo validador → mismo fallo. Gastó 2 de 3 reintentos. |
| 7 | PRs previos corrigieron síntomas | **Confirmada** | #188 arregló otros dos jobs (anclas, cierre). #190 acepta solo claves extra **vacías**; sigue rechazando `evidence.quote` copiado (comprobado: falla con el mismo mensaje) y mantiene el fallo de forma como terminal. |

## 4. Nueva arquitectura (sin rebajar estándares)
- **A · Generación creativa**: sin cambios de prompt (cambiar prompts cambia la huella del ledger y haría pagar de nuevo lo ya pagado). Recomendación futura versionada: quitar `.strict()` del contrato pedido y no enviar `originalFirstAnswer` en forma tolerante.
- **B · Normalización técnica tolerante** (`response-normalizer.ts`, usado por `validateDocumentaryValue` → todas las micro-llamadas): reglas cerradas y sin pérdida — R1 clave desconocida vacía/null; R2 anotación primitiva dentro de una evidencia que ya trae `excerptId` (el servidor siempre deriva el texto del ID). Envolturas sin contenido (BOM, valla ``` con/sin salto). Sigue fallando: tipos erróneos, campos ausentes, enums fuera de contrato, contenido estructurado extra, prosa, truncado. No muta la respuesta guardada; idempotente; registra `[atomivid:documentary-format-normalized]`.
- **B · Marcas de edición**: `anchorCreativeDirectionSpans` ancla una marca no literal al tramo literal más largo y único de su MISMO bloque (≥12 palabras, o ≥8 y ≥50 %). La narración nunca cambia; marcas inventadas siguen bloqueando. Solo para comprobación local e informe aprobado: el prompt del revisor mantiene el anclaje de #188 (huella idéntica).
- **C · Evaluación editorial**: si la verificación de la primera recompensa no aporta evidencia válida (forma irrecuperable, fragmento tardío o inventado), ya no es un fallo técnico terminal: queda `delivered=false` con explicación explícita → **bloqueo editorial** y corrección prevista. Nunca aprueba sin evidencia.

## 5. Comparación con #188 y #190
- **#188** (merged, e68da2b): corrigió `290de42b`/`dbc89879` (anclas y cierre). No toca la comprobación de apertura: el incidente ocurrió después de su despliegue.
- **#190** (abierto, `claude/editorial-format-root-cause`, incluye e68da2b): mismo diagnóstico de forma, solución más estrecha (solo claves vacías) y sin capa C. Toca los mismos archivos → **conflicto con esta rama**: hay que elegir uno. Con nuestra prueba de reproducción: #190 pasa el incidente exacto pero falla la variante `evidence.quote` copiada.

## 6. Incidentes: ¿recuperables sin pagar?
- **Hasta el veredicto editorial: sí.** Con esta rama, el replay del job real con ledger simulado aprueba la apertura reutilizando la respuesta pagada (0 llamadas nuevas).
- **Hasta guion aprobado: probablemente no al 100 %.** Según el replay de #190 sobre el ledger real, tras aceptar la apertura la revisión real del crítico trae observaciones de contenido → la corrección prevista necesita ≥1 llamada nueva (escritor + revisor, ordinariamente ~0,2 USD). No pude confirmarlo yo (Storage).
- **Recuperación propuesta (no ejecutada):** 1) ejecutar `RESCATE_CONFIRM_READ_ONLY=1 … npx tsx scripts/rescate-replay-incident.ts --job=e8048599` (solo lectura, rechaza cualquier llamada sin respuesta guardada, idempotente); 2) tras merge+deploy aprobados, el propietario pulsa «Reintentar» (CAS en `updated_at`, queda 1 reintento) → reutiliza las 5 respuestas gratis. Sin escrituras ni migraciones. Reels, podcast y formato corto no importan `json-response.ts` (comprobado con grep): sin impacto.

## 7. Archivos modificados
- `src/lib/video/long-form/response-normalizer.ts` (nuevo, capa B)
- `src/lib/video/long-form/json-response.ts` (usa la capa B)
- `src/lib/video/long-form/editorial-opening-repair.ts` (capa C)
- `src/lib/video/long-form/creative-direction.ts` (`anchorCreativeDirectionSpans`, `longestSharedSpan`)
- `src/lib/video/long-form/documentary-script.ts` (anclaje por tramo solo para comprobación local/informe)
- `src/lib/video/long-form/editorial-opening-repair.test.ts` (una prueba adaptada a la capa C)
- `src/lib/video/long-form/editorial-rescue.test.ts`, `editorial-rescue-repro.test.ts`, `__fixtures__/incident-e8048599-draft.json` (nuevos)
- `scripts/rescate-replay-incident.ts` (nuevo, replay read-only con puertas)
- `.github/workflows/rescate-motor-editorial.yml` (nuevo, Node 22), `package.json` (`test:rescate`, y las nuevas pruebas en `test:unit`/`test:editorial`)

## 8. Resultados de pruebas (sin llamadas pagadas; proveedores simulados)
- `test:rescate`: 23/23 (editorial-rescue 15 + repro 2 + opening-repair 6, una adaptada a la capa C).
- Reproducción contra `e68da2b`: **2/2 fallan con «La respuesta no cumple el formato editorial requerido»** (el error de producción); en la rama pasan.
- `test:editorial` 172/172 · `test:spend` 406/406 · `tsc --noEmit` limpio (tras `next typegen`) · eslint sin errores en archivos tocados.
- `test:unit` local (Node 20): 2206/2212; los 6 fallos (`recovery-flow`, `attempt-state`) fallan igual en `e68da2b` por falta de WebSocket nativo en Node 20 → ambiental. **CI en Node 22 (commit a9d519a): suite unitaria completa, tipos y lint verdes.**
- REAL vs SIMULADO: el borrador y el historial creativo son datos reales persistidos; las respuestas del crítico y de la comprobación son simulaciones con la forma del incidente.

## 9. Riesgos residuales
1. Forma exacta de las respuestas reales no verificada por mí (Storage). 2. La aprobación final del job probablemente requiere 1 corrección pagada. 3. R2 descarta anotaciones no usadas dentro de evidencias (pérdida de información irrelevante para la decisión, registrada). 4. La capa C convierte un fallo técnico en corrección: puede gastar la corrección prevista (dentro de los topes de gasto existentes). 5. Conflicto con #190. 6. La regla fija de 150 palabras para 5 y 15 min no se cambió (decisión editorial del propietario). 7. Prompts de reparación aún inducen ruido (corrección requiere versionar contrato).

## 10. Veredicto
**GO condicionado para revisión independiente / NO-GO para despliegue inmediato** hasta: (a) ejecutar el replay read-only contra el ledger real; (b) decidir entre esta rama y #190; (c) revisión de un tercero (no me apruebo a mí mismo).

## 11. CI (GitHub Actions, commit a9d519a)
- Rescate motor editorial (Node 22) — pull_request: success — https://github.com/hanzmo16-png/Atomivid/actions/runs/39989870674 (incluye el paso que exige que e68da2b falle con el error original)
- Rescate motor editorial (Node 22) — push: success — https://github.com/hanzmo16-png/Atomivid/actions/runs/39989843100
- E2E fixture evidence (no paid providers): success — https://github.com/hanzmo16-png/Atomivid/actions/runs/39989870740
- podcast-2-1-e2e: typecheck y regression success; e2e en curso al redactar — https://github.com/hanzmo16-png/Atomivid/actions/runs/39989870840

## 12. Cierre definitivo — respuesta a las auditorías de Claude (comentario en #191) y ChatGPT (ATOMIVID_20261023_1215CUN__chatgpt__AUDITORIA-PR191-MOTOR-EDITORIAL.md)

### ALTO-1 (Claude) / P0 (ChatGPT): R2 descartaba contenido con significado → RESUELTO
- R2 genérico **eliminado** de `response-normalizer.ts`. La normalización genérica es SOLO R1 (clave desconocida null/blanco).
- Allow-list **por contrato** en `editorial-opening-repair.ts` (`dropVerifiedEvidenceEchoes`): solo `quote` y `beatIndex` dentro de `firstAnswer.evidence`, y solo si coinciden con el texto y el bloque del `excerptId` en el catálogo. Un eco distinto se conserva y el esquema estricto lo rechaza.
- Contradicción explícita (`assertNoVerdictContradiction`): si la evidencia trae una clave de veredicto (`delivered`, `resolvesPromise`, `severity`, `function`, `supported`, `verified`, `verdict`, `approved`) con valor distinto del veredicto padre → `OpeningVerdictContradictionError` (técnico, issue `contradiction@firstAnswer.evidence.delivered`). Nunca se borra la contradicción y nunca se aprueba.
- Una apertura que el modelo declaró fallida (`delivered=false`) nunca se convierte en aprobada y conserva la explicación del modelo.
- Pruebas: `editorial-rescue-audit.test.ts` → A2, `supported:false`/`confidence`/`contradicted`/`verified`/`explanation`/`note`, eco no coincidente, `delivered=false` preservado. El A2 original de Claude (que registraba `delivered=true`) ahora falla con `OpeningVerdictContradictionError`, que es lo esperado.

### ALTO-2 (Claude) / P1 (ChatGPT): la capa C gastaba una corrección pagada por fallos técnicos → RESUELTO
- Truncado (`max_tokens`), JSON ilegible, prosa, objeto vacío, tipos erróneos, campos ausentes y contenido extra se propagan como `DocumentaryResponseError` → `failure_kind=technical` (reintento técnico; reutiliza la respuesta guardada; sin corrección editorial).
- La capa C queda **solo** para un resultado de CONTENIDO bien formado: `delivered=true` con evidencia tardía o inexistente → `delivered=false` (observación editorial).
- Pruebas: A1 (cinco formas técnicas → técnico); para los tres formatos, una respuesta inválida termina como técnica con **1 sola llamada al escritor** (no hay corrección).

### MEDIO-1: cobertura → RESUELTO
`acceptContract` (R1 + esquema completo) es el único punto de aceptación en: `applyVisualAnchorRepair`, `recoverVisualPlan` (respuesta de escena), `applyFunctionRepair` y `sectionFunctionRepairTargets`, `parseVisualPlan`, además de `validateDocumentaryValue`. Pruebas: clave vacía extra aceptada y clave con contenido rechazada en cada uno (A13 de Claude ahora da `visualAnchorEmptyExtraKeyRejected:false`).

### MEDIO-2: huella del escritor en la corrección → RESUELTO
El anclaje por tramo se usa para las comprobaciones locales y solo se escribe en `parsed.creativeDirection` **al aprobar**. Los prompts de revisión y de corrección conservan la dirección creativa del escritor (anclaje #188) → mismas claves del ledger. Prueba MEDIO-2 (mutación verificada: con la asignación antigua la prueba falla). Prueba de idempotencia: misma clave de ledger antes y después de normalizar.

### BAJO
- Umbral de anclaje igualado a #190: ≥12 palabras o ≥8 y **≥60 %**. Prueba con 8/15 palabras (53 %) → ya no ancla. La marca real de e8048599 sigue anclando (15 palabras).
- `e8048599` tiene `retry_count=2`: queda **1** reintento técnico (MAX 3).

### Reproducción de incidentes (REAL vs SIMULADO)
- **e8048599** (REAL: borrador e historial creativo; SIMULADO: respuesta de la comprobación con la forma del ledger). Solo necesita R1. Aprobación de apertura con 1 llamada simulada, reintento con 0. Contra `e68da2b` falla con el error original (paso de CI). Replay de Claude con las respuestas reales a `43b865d`: reutiliza las 5 (0,2781 USD), `normalizations:1` (R1), `unverifiedOpening:0`, llega a «Afinando la historia» (la corrección requerirá una llamada nueva). Esta rama no cambia esa ruta: R1 sigue igual y la capa C no se activa.
- **dbc89879** y **290de42b** (REAL: borrador + revisión RESUELTA guardada en `editorial_checkpoint`, SELECT): revisión válida, 0 bloqueos, 0 problemas locales; pipeline aprobado sin llamadas nuevas (`editorial-rescue-real-jobs.test.ts`).
- Respuestas CRUDAS del proveedor: en Storage, **no legibles sin credenciales de servicio** (no usadas por mí). Evidencia con respuestas reales: solo el replay de Claude a `43b865d`, run https://github.com/hanzmo16-png/Atomivid/actions/runs/39994804692.

### Resultados locales (Node 20)
`test:rescate` 39/39 · `test:editorial` 188/188 · `test:spend` 406/406 · `test:saas` 419/421 · `test:unit` 2218/2224 · `tsc` limpio · eslint limpio en long-form. Los 8 fallos (`recovery-flow`, `attempt-state`) son ambientales (no hay WebSocket nativo en Node 20) e idénticos en `e68da2b`; en CI con Node 22 pasan.

### Riesgos pendientes
1. Aprobación final de e8048599: probablemente 1 corrección pagada; necesita autorización explícita. 2. Contradicciones en texto libre (p. ej. `explanation` que niega `delivered=true`) no se detectan de forma determinista; sigue mandando el veredicto estructurado y la revisión crítica. 3. #190 sigue abierto y entra en conflicto: si se integra #191, cerrar #190. 4. Prompts de reparación aún inducen ruido (cambiarlos requiere versionar el contrato).
