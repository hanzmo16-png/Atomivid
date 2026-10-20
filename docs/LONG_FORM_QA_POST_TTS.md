# Long Form — controles de QA que ocurren DESPUÉS de la voz (TTS) y propuesta de predicción gratuita

Tarea T-20261019-1553-chatgpt-01 (punto 3, opcional). **Solo documento y propuesta: no hay implementación de la predicción.**
Referencias de línea sobre `src/lib/video/long-form/produce.ts` en esta rama (base 35fb212).

## Orden real del worker (`generateLongFormVideoFromScript`)

| # | Paso | Línea | ¿Gasta? |
|---|------|-------|---------|
| 0 | Reconciliación de salida ya entregada | ~255 | No |
| 1 | v4+: `visualReleasePreflight` (identidad/prueba HERO, ratio estimado de tarjetas, apertura) | 268 | No |
| 1b | **v3 (nuevo): `datedEventEvidenceBlockers` → `LongFormDatedEventEvidenceError`** | 275 | No |
| 2 | Apertura del presupuesto / tope duro | 292 | No |
| 3 | **Voz (TTS) por beat** — `buildLongFormTimeline` | 346 | **Sí (ElevenLabs en producción)** |
| 4 | Selección + descarga de stock / imagen IA / video IA por escena — `executeShot` | 448 | Stock gratis; IA **sí** |
| 5 | Informe visual + `assertVisualQuality` (repeticiones sin justificar, tarjetas-título, BLOCK de `DELIVERY_POLICY`) | 513 | — (ya se gastó 3–4) |
| 6 | `LongFormQualityError` si tarjetas > `MAX_TEXT_FALLBACK_RATIO` (25 %) | 515 | — |
| 7 | **Nuevo: `LongFormPendingMaterialError` si alguna escena lleva «Material pendiente»** | 561 | — (evita música, render y subida) |
| 8 | Música (`gatedMusicTrack`; fallo → sin música, solo `console.warn`) | 568 | Biblioteca curada: no |
| 9 | Render Remotion (`assertCardsFit`; `assertApprovalReady` solo si `purpose === "approval"`) | 612 / render.ts 81–82 | CPU |
| 10 | Masterización de loudness (fallo → se sube sin normalizar) | 646 | No |
| 11 | Entrega idempotente `finalizeLongFormOutput` | 662 | Storage |

Controles que hoy solo se conocen **después** de pagar la voz: 5, 6 y 7 (y la parte de 1 que depende de candidatos reales de stock).
Los pasos 5–7 dependen de *qué* devuelve el proveedor de stock para cada escena (pertinencia léxica, unicidad en el documental,
fallos de descarga), cosa que el plan no sabe.

## Propuesta: predicción gratuita de tarjetas ANTES de la TTS (no implementada)

Objetivo: detener con `voiceCalls = 0` los casos en que el fallo de 6/7 es **inevitable**.

1. Con `planShotsFromScript` (ya se usa en el preflight v4, sin TTS) obtener las escenas estimadas y su intención anclada.
2. Para cada intención **distinta**, una búsqueda de candidatos (`searchVideoCandidates`/`searchImageCandidates`), **sin descargar**,
   con caché por consulta. Pexels es gratuito pero con límite de tasa: presupuesto máximo de consultas por documental y espera
   con latido (ya existe `setFootageWaitBeat`).
3. Ejecutar sobre esos candidatos la MISMA lógica de `stock-selection.ts` (pertinencia + unicidad simulada con el registro del
   documental) para contar escenas sin candidato pertinente y único → `predictedGaps` y `predictedCardRatio`.
4. Bloquear antes de la TTS solo si `predictedCardRatio > MAX_TEXT_FALLBACK_RATIO` o `predictedGaps > 0` **con margen**
   (p. ej. menos candidatos pertinentes que escenas que los piden). En otro caso continuar; los controles 5–7 siguen siendo la
   autoridad final (fallo cerrado).
5. Prueba negativa sugerida: catálogo sintético con 2 intenciones sin candidato → error antes de la TTS, `voiceCalls === 0`,
   `stockDownload === 0`.

### Límites explícitos
- Es una **estimación**: los cortes reales dependen de los tiempos por palabra de la TTS (la duración real fue +10 % sobre el plan
  en la QA); el número de escenas por beat puede cambiar.
- La unicidad real usa la huella del archivo descargado (SHA-256/dHash); sin descargar, solo se puede usar `sourceId`/URL, que no
  detecta duplicados con distinto id.
- Las descargas que fallan (red, 404) no son predecibles.
- Las búsquedas consumen cuota de la API de stock (gratuita pero limitada); no deben repetirse en cada visita a Configurar.
- No predice imagen/video IA (cuyo resultado tampoco se conoce sin pagar).
- Un falso negativo (predicción “ok” y fallo real) sigue cayendo en 6/7, ya fail-closed, pero después de pagar la voz
  (la caché TTS evita volver a pagarla en un reintento del mismo guion).
