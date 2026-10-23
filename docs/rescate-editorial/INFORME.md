# Operación rescate del motor editorial — informe independiente (Grok)

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
