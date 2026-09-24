# ATOMIVID Long Form — HANDOFF DE CONTINUIDAD (VIDEO #001, Göbekli Tepe)

**Fecha de este handoff:** 2026-09-23
**Propósito:** que cualquier otro agente pueda retomar el proyecto inmediatamente, sin releer todo el historial de conversación, sin repetir investigación ya hecha, y sin arriesgar gasto duplicado o regresión del pipeline 9:16.
**Este documento es solo consolidación. No contiene investigación nueva, código nuevo, ni resultados de generación.**

---

## 1. Rama actual

```
claude/atomivid-mvp-setup-0079jv
```

Todo el trabajo de Long Form (incluido este handoff) vive en esta rama. No hay PR abierto, no hay merge, no hay deployment.

## 2. Último commit válido

```
7357c75  fix(long-form): persistent cross-process TTS idempotency per beat
```

Este es el HEAD de la rama en el momento de este handoff. El guion v.003, el storyboard v.003 (con las 5 licencias resueltas) y la Visual Bible v1 siguen **aprobados por el usuario** como base editorial. Este commit es técnico/preparatorio (sin cambios editoriales) — ver sección 3.

## 3. Commits relevantes anteriores y qué aporta cada uno

| Commit | Aporte |
|---|---|
| `ebe56eb` | Paquete de preproducción V.002: `gobekli-script-002-final.{json,md}` (guion aprobado con ajustes, 1,404 palabras), `gobekli-storyboard-001.json` (44 shots, 0 IA), `gobekli-production-plan-001.md`. Primer research pack (#001, 3 fuentes). |
| `275d290` | Reclasificación híbrida-premium: `gobekli-storyboard-002-hybrid.json` (mismo storyboard-001 pero con `hybridClassification`/`hybridReason` por shot), `gobekli-visual-test-001.md` (3 prompts de prueba diseñados, identidad visual compartida, NO generados — falta `OPENAI_API_KEY`). `-001` se conserva intacto. |
| `7e026db` | Actualización 2026: `research-pack-002.json` (extiende, no reemplaza, research-pack-001), `gobekli-script-003-current.{json,md}` (guion v3, 13 beats, 1,847 palabras, tesis moderada), `gobekli-storyboard-003.json` (45 shots, estrategia híbrida), `gobekli-production-plan-003.md`, `atomivid-long-form-visual-bible-v1.md` (guía visual reutilizable para futuros videos). |
| `bbde376` | Checkpoint de verificación dirigida post-aprobación: confirma Gresky/Clare **NOT VERIFIED** (segundo intento), resuelve los 5 shots `NEEDS_REVIEW` de licencias (0 quedan sin fallback), documenta un tercer intento de verificación de coordenadas (señal fuerte pero no confirmada de primera mano). Actualiza `research-pack-002.json`, `gobekli-storyboard-003.json`, `gobekli-production-plan-003.md`. |
| `af6b846` | Primera versión de este mismo HANDOFF-PRODUCTION-V1.md (consolidación, cero código). |
| `7064285` | Preparación técnica de producción, sin cambios editoriales: conecta el storyboard curado (45 shots) al render real (antes usaba un ciclo genérico — hallazgo mayor, ver sección 4), corrige 2 bugs reales de seguridad de costo (fallback silencioso a fixture en modo real; reintento automático de OpenAI Images ante consumo incierto), y prepara (sin ejecutar) el Visual Test V2, el cost guard de VIDEO #001, y QC post-render. Validado con un dry-run real end-to-end (sección 19) y 621/621 tests. |
| `911f8ba` | Actualización del handoff tras el checkpoint anterior (sin cambios de código). |
| `7357c75` | **Este checkpoint.** Resuelve el único gap de producción que quedaba documentado: idempotencia TTS entre procesos. Añade `src/lib/video/long-form/tts-cache.ts` (caché persistente por beat con identidad determinística e integración con el cost guard de VIDEO #001) y `getVoiceIdentity()` en `src/lib/ai/voice.ts`. Sin cambios editoriales ni de guion/storyboard/Visual Bible. Ver sección 20. Validado con 645/645 tests. |

**Ningún commit de este historial modifica el pipeline 9:16 (Shorts).** `7064285` sí modifica código de producción de Long Form (ver sección 4) — es el primer commit de este historial que lo hace; todos los anteriores desde `ebe56eb` eran solo contenido (`content/long-form/`). Antecesores más antiguos (`9130d24`, `3ff03d9`, `40893a4`) construyeron la infraestructura Long Form original de Fase A.

## 4. Archivos Long Form relevantes y propósito

### Contenido (`content/long-form/`)

| Archivo | Propósito | Estado |
|---|---|---|
| `atomivid-long-form-visual-bible-v1.md` | Guía de identidad visual y reglas de clasificación de assets, reutilizable para cualquier video Long Form futuro (no solo Göbekli Tepe). | Vigente |
| `gobekli-tepe-001/gobekli-script-002-final.{json,md}` | Guion v.002, aprobado con ajustes. Histórico — superado por v.003 pero **conservado, nunca borrado**. | Histórico, no usar para producción |
| `gobekli-tepe-001/gobekli-storyboard-001.json` | Storyboard original, 44 shots, 0 IA. Histórico. | Histórico, no usar |
| `gobekli-tepe-001/gobekli-storyboard-002-hybrid.json` | Storyboard-001 reclasificado a estrategia híbrida. Histórico. | Histórico, no usar |
| `gobekli-tepe-001/gobekli-production-plan-001.md` | Plan de producción de la v.001/v.002. Histórico. | Histórico |
| `gobekli-tepe-001/gobekli-visual-test-001.md` | 3 prompts de prueba visual de la v.002 (identidad visual compartida, nunca generados). Histórico — **superado por los 3 prompts de la sección 14 de este handoff**, que son los que se deben usar ahora. | Histórico, prompts ya no vigentes |
| `gobekli-tepe-001/research-pack-002.json` | **Fuente de investigación vigente.** Extiende research-pack-001 (embebido en script-002) con hallazgos 2026, incluye los 2 intentos de verificación dirigida (Gresky/Clare y coordenadas). | **VIGENTE** |
| `gobekli-tepe-001/gobekli-script-003-current.{json,md}` | **Guion vigente y aprobado.** 13 beats, 1,847 palabras. El `.json` es el que consume `script-loader.ts`. | **VIGENTE — PRODUCTION READY (editorial)** |
| `gobekli-tepe-001/gobekli-storyboard-003.json` | **Storyboard vigente y aprobado**, con las 5 licencias ya resueltas (commit `bbde376`). | **VIGENTE — PRODUCTION READY (editorial)** |
| `gobekli-tepe-001/gobekli-production-plan-003.md` | Plan de producción vigente: resumen de investigación, decisión de tesis, modelo de costos, checklist de validación, y (sección 9) el resultado del checkpoint de verificación dirigida. | **VIGENTE** |
| `gobekli-tepe-001/HANDOFF-PRODUCTION-V1.md` | Este documento. | **VIGENTE** |
| `gobekli-tepe-001/visual-test-v2-manifest.json` | Manifest materializado (generado desde `src/lib/video/long-form/visual-test-v2.ts`) de las 3 imágenes del Visual Test V2: prompts finales ya compuestos, `idempotencyKey`, `outputPath`, costo estimado. Regenerar con el script en la sección 16 si cambia algo en `visual-test-v2.ts`. | **VIGENTE** |
| `gobekli-tepe-001/gobekli-asset-manifest-003.json` | Manifest completo de los 45 shots (timing escalado a la duración real estimada, `assetClass`, `provider`, `queryOrPrompt`, `expectedOutput`, `fallback`, `licenseStatus`, `factualSensitivity`) — generado desde `storyboard-shots.ts` + `gobekli-storyboard-003.json` + `gobekli-script-003-current.json`. Se recalculará con timing REAL tras la síntesis TTS real. | **VIGENTE** |

### Código — base de Fase A (sin cambios de comportamiento salvo lo indicado)

| Archivo | Propósito |
|---|---|
| `src/lib/video/long-form/types.ts` | Tipos base: `NarrativeBeat`, `Shot`, `LongFormClaim`, `LongFormSource`, etc. Sin cambios. |
| `src/lib/video/long-form/script-loader.ts` | Carga y valida (Zod) un guion real ya finalizado (como `gobekli-script-003-current.json`) al formato que `buildLongFormTimeline()` espera. Sin cambios. |
| `src/lib/video/long-form/timeline.ts` | TTS por beat + stitching + timeline real (`MAX_TTS_CHARS_PER_CALL=9000`). **Cambio este checkpoint:** `buildLongFormTimeline()` ahora acepta un 4º parámetro opcional `shotsBuilder` (default: `shotsForSpan`, comportamiento previo intacto) — permite inyectar `buildShotsFromStoryboard` para usar un storyboard curado real en vez del ciclo genérico. |
| `src/lib/video/long-form/diagram-map.ts` | Generador determinístico FIXTURE de mapas/diagramas/tarjetas de texto (datos de ejemplo). Sin cambios — sigue siendo el default si no se pasa `--storyboard`. |
| `src/lib/video/long-form/asset-resolver.ts` | Resuelve cada `shot.type` al proveedor correcto (Pexels/OpenAI/determinístico). Sin cambios de comportamiento (ya aceptaba `graphicSpecFor` inyectable desde Fase A). |
| `src/lib/video/long-form/mode.ts` | **Gate de seguridad.** `resolveLongFormProviders(mode)`. **Bug real encontrado y corregido este checkpoint:** en modo `real`, si faltaba una credencial, los getters compartidos con Shorts (`getVoiceProvider()` etc.) caían EN SILENCIO a `fixture` — porque su guardia (`requireRealProvider`) solo actúa cuando `isProductionRuntime()` es true (Vercel), nunca cuando el orquestador corre como script CLI local. Ahora `resolveLongFormProviders("real", ...)` lanza `LongFormRealProviderMissingError` si CUALQUIER proveedor resuelto es `"fixture"` — modo real nunca puede terminar en contenido de fixture sin decirlo. |
| `src/lib/video/long-form/documentary-script.ts` | Generador real de guion vía Claude — no se usa en este video. Sin cambios. |
| `src/lib/video/long-form/shots.ts` | `shotsForSpan()` — el generador GENÉRICO de sub-shots (ciclo de tipos, ignora cualquier storyboard). Sigue siendo el default. Sin cambios. |
| `src/lib/video/long-form/render.ts` | Wrapper de render hacia `remotion/LongFormDoc.tsx`. **Cambio este checkpoint:** ahora llama `assertRenderInputValid()` (render-preflight.ts) ANTES de bundle/renderMedia — detiene con un error claro si hay huecos entre escenas, subtítulos fuera de rango, audio faltante, etc., en vez de renderizar (y gastar tiempo, y en real mode assets ya pagados) un video roto. |
| `remotion/LongFormDoc.tsx` | Composición Remotion 16:9, independiente de `VerticalReel.tsx` (9:16). Sin cambios — verificado con test estático nuevo (`remotion/long-form-independence.test.ts`). |
| `remotion/Root.tsx` | Registra ambas composiciones. Sin cambios. |
| `scripts/produce-long-form-video.ts` | **Orquestador.** **Cambio este checkpoint:** nuevo flag `--storyboard=<ruta>` (exige `--script`). Ver comandos exactos en la sección 16. |

### Código NUEVO este checkpoint (hallazgo mayor + preparación técnica para producción)

**Hallazgo mayor:** el storyboard curado (45 shots con `hybridClassification`/licencias/prompts ya decididos en preproducción) **nunca llegaba al render** — `shotsForSpan()` generaba su propio ciclo genérico de tipos de asset sin relación con ningún storyboard, y los gráficos de texto/diagrama/mapa eran siempre datos de ejemplo (`isFixture:true`). Los siguientes módulos resuelven esto de forma aditiva (el comportamiento SIN `--storyboard` queda exactamente igual que antes):

| Archivo | Propósito | Tests |
|---|---|---|
| `src/lib/video/long-form/storyboard-shots.ts` | `buildShotsFromStoryboard()` — convierte los shots de planeación de un storyboard real (con su `durationApprox`) en `Shot[]` reales, escalando proporcionalmente cada uno al span REAL narrado del beat (que solo se conoce tras la síntesis TTS). Preserva `assetType`→`ShotType`, `hybridClassification`→`source`, `visualIntent`/licencia. Nunca inventa un shot que el storyboard no tenga. | 7/7 ✅ |
| `src/lib/video/long-form/storyboard-loader.ts` | `loadStoryboardFromFile()` — carga y valida (Zod) un storyboard real, agrupado por `beatId`. Mismo patrón que `script-loader.ts`. Probado contra `gobekli-storyboard-003.json` real (45 shots, 13 beats). | 4/4 ✅ |
| `src/lib/video/long-form/real-graphics.ts` | `realGraphicSpecProvider()` — construye specs de texto/diagrama/mapa REALES (`isFixture:false`) a partir del texto ya redactado en el storyboard (`shot.captionText`, que lleva el `visualIntent` original) — nunca de datos de ejemplo. Parsea citas literales (`'texto' — contexto`), cadenas `paso1 -> paso2 -> paso3` en diagramas, y usa coordenadas verificadas conocidas para los 2 shots de mapa. Probado contra los 30 shots reales de texto/diagrama/mapa del storyboard-003 (ninguno lanza, todos producen contenido real). | 9/9 ✅ |
| `src/lib/video/long-form/render-preflight.ts` | `assertRenderInputValid()` — valida ESTÁTICAMENTE (sin renderizar) que las escenas cubren el rango completo sin huecos/superposiciones, que hay audio, que los subtítulos caen dentro de rango. Wireado en `render.ts`. | 12/12 ✅ |
| `src/lib/video/long-form/long-form-qc.ts` | QC POST-render: `probeVideoFile`/`evaluateVideoProbe` (ffprobe real: resolución/fps/duración/audio/"no corrupto"), `evaluateProductionReportForRealRun` (detecta un report.json marcado como real que en realidad es fixture/simulation, o con shotCount que no coincide con el storyboard), `detectAnomalousSilences` (ffmpeg `silencedetect`). Probado contra archivos .mp4 reales generados con ffmpeg (no mocks). | 12/12 ✅ |
| `src/lib/video/long-form/video-cost-guard.ts` | Barrera de costo ESPECÍFICA de VIDEO #001 (no del sistema genérico Long Form): `VISUAL_TEST_V2_MAX_USD=$0.50`, `VIDEO_001_HARD_STOP_USD=$3.00`. Ledger persistente en `.atomivid-state/` (gitignored) — un gasto real confirmado se anota sincrónicamente en disco, así que un reintento en un proceso NUEVO ve el gasto acumulado y no puede superar el hard stop. | 10/10 ✅ |
| `src/lib/video/long-form/visual-test-v2.ts` | Manifest tipado de las 3 imágenes del Visual Test V2: `VIDEO_001_VISUAL_STYLE` (bloque de estilo compartido, compuesto en cada prompt, no duplicado), `computeIdempotencyKey()` (hash determinístico de shotId+modelo+tamaño+calidad+prompt+negativo → `outputPath` único), `shouldGenerate()` (false si el archivo ya existe — nunca regenera/re-cobra el mismo shot). | 10/10 ✅ |
| `scripts/generate-visual-test-v2.ts` | Ejecutor listo pero **NO ejecutado** — genera las 3 imágenes reales cuando exista `OPENAI_API_KEY` y se confirme `--confirm=YES_SPEND_REAL_MONEY`. Por cada shot: `shouldGenerate()` antes de llamar (idempotencia), `assertCanSpend()` antes de llamar (cost guard), `recordSpendToDisk()` inmediatamente después de una llamada exitosa (persistencia ante crash). | — (script de ejecución, no una librería con tests unitarios) |
| `remotion/long-form-independence.test.ts` | Test estático (lee código fuente, no ejecuta nada) que confirma que `LongFormDoc.tsx` y `render.ts` nunca importan de `VerticalReel.tsx` ni `generate-video.ts`. | 3/3 ✅ |
| `src/lib/video/long-form/tts-cache.ts` | **Nuevo (checkpoint posterior).** Idempotencia persistente por beat de la síntesis TTS real: identidad determinística (videoId+beatId+texto+voiceId+modelId+parámetros de voz+idioma+proveedor) → clave → registro `STARTED`/`COMPLETED`/`NEEDS_REVIEW` en disco + audio con checksum. `synthesizeBeatNarrationCached()` reutiliza sin llamar al proveedor si hay un `COMPLETED` válido, lanza `TtsUncertainCostStateError` (nunca reintenta solo) ante un `STARTED` sin resolver, y hace bypass total para el proveedor `fixture` (nunca puede quedar cacheado como si fuera real). Wireado en `timeline.ts` (`BeatSynthesizer` inyectable, default sin cambios) y en `produce-long-form-video.ts` (automático con `--storyboard`, conectado al cost guard de VIDEO #001 cuando el `videoId` coincide). | 20/20 ✅ |
| `src/lib/ai/voice.ts` (`getVoiceIdentity()`) | **Nuevo, aditivo.** Expone voiceId/modelId/parámetros de voz relevantes (nunca `speed`, que es un ajuste por llamada) para que `tts-cache.ts` pueda construir la identidad de caché sin duplicar constantes internas del módulo. | 4/4 ✅ |

Todos los archivos de código nuevos están cubiertos por tests, registrados en `package.json`'s `test:unit`. Ver sección 6 para el conteo total.

## 5. Estado actual de cada pieza

| Pieza | Estado |
|---|---|
| Research pack | `research-pack-002.json` — 8 fuentes (3 heredadas + 5 nuevas), 5 hallazgos 2026 clasificados por certeza, 2 intentos de verificación dirigida documentados (Gresky/Clare, coordenadas). |
| Guion v.003 | `gobekli-script-003-current.json` — 13 beats, 1,847 palabras, 11,629 caracteres, ~659.6s (~11.0 min) estimados. Tesis moderada. Valida contra `script-loader.ts` real (confirmado con `loadScriptFromFile()`). |
| Storyboard v.003 | `gobekli-storyboard-003.json` — 45 shots. Distribución final (post-resolución de licencias): TEXT 17 · AI_RECREATION 11 · DETERMINISTIC 13 · STOCK_REAL 4 · REAL_DOCUMENTARY 0. |
| Production plan | `gobekli-production-plan-003.md` — incluye sección 9 con el resultado del checkpoint de verificación dirigida. |
| Visual Bible | `atomivid-long-form-visual-bible-v1.md` — taxonomía de 5 categorías, reglas duras (restos humanos nunca IA, geografía/cronología siempre determinístico, etc.), identidad visual compartida, formato del ledger de licencias. |
| `script-loader.ts` | Sin cambios de código. |
| Orquestador Long Form | **Nuevo flag `--storyboard=<ruta>`** (exige `--script`) — usa los 45 shots curados reales en vez del ciclo genérico, y gráficos reales en vez de fixture. Probado end-to-end en modo `simulation` contra `gobekli-script-003-current.json` + `gobekli-storyboard-003.json` (ver sección 6 para el resultado). |
| Gate de modo real (`mode.ts`) | **Bug corregido:** ya no puede degradar en silencio a fixture en modo real — ver tabla de código en sección 4. |
| Render preflight | **Nuevo** — `render.ts` valida estructura de escenas/captions/audio antes de renderizar (`render-preflight.ts`). |
| QC post-render | **Nuevo, preparado pero no ejecutado sobre un render real** — `long-form-qc.ts` (ffprobe real + detección de silencios + validación del report.json). |
| Cost guard VIDEO #001 | **Nuevo** — `video-cost-guard.ts` ($0.50 Visual Test V2 / $3.00 hard stop), ledger persistente en `.atomivid-state/` (gitignored). |
| Visual Test V2 | **Nuevo, preparado pero NO ejecutado** — manifest tipado + idempotencia (`visual-test-v2.ts`) + ejecutor listo (`scripts/generate-visual-test-v2.ts`, nunca corrido). |

## 6. Confirmaciones de calidad

- ✅ **645/645 tests unitarios** (`npm run test:unit`) — 621 del checkpoint `7064285` + 24 nuevos del fix de idempotencia TTS (`tts-cache.test.ts` 20/20 + `voice.test.ts` 4/4).
- ✅ **`npm run build`** (`next build`) limpio — sin errores de TypeScript ni de build.
- ✅ **Typecheck** limpio (`npm run typecheck` → `tsc --noEmit`, sin errores).
- ✅ **Lint** limpio (`npm run lint` → eslint, sin errores).
- ✅ **Pipeline 9:16 (Shorts) intacto** — cero archivos de `VerticalReel.tsx`, `generate-video.ts`, o cualquier ruta del pipeline vertical fueron tocados. Verificado además con un test estático nuevo (`remotion/long-form-independence.test.ts`) que falla si algún día se agrega un import cruzado.
- ✅ **Dry-run end-to-end** en modo `simulation` con `--script` + `--storyboard` (guion y storyboard reales v.003, los 45 shots curados) — confirma que los 45 shots llegan correctamente hasta la composición y que el .mp4 resultante pasa QC (ffprobe: 1920x1080/30fps, audio presente, duración dentro de tolerancia). Resultado completo (`report.json` + QC) documentado al pie de este archivo, sección "Resultado del dry-run" — si esa sección todavía dice "en curso", el dry-run no había terminado al momento de escribir esta versión del handoff; volver a correr el comando de la sección 16 si hace falta confirmarlo de nuevo.

## 7. Especificación del VIDEO #001 (estado vigente)

- **Tesis (moderada, evidence-driven):** *"Göbekli Tepe es un sitio que sigue obligando a corregir, temporada tras temporada, la imagen que teníamos de él"* — explícitamente NO la versión dramática ("todo lo que sabíamos está cambiando"), porque su evidencia clave (paper Gresky/Clare) no se pudo verificar.
- **Duración estimada:** 659.6 s (~11.0 min). Orientativa, dentro del rango 10-20 min pedido; no es un objetivo fijo.
- **Palabras:** 1,847. **Caracteres:** 11,629.
- **Beats:** 13 (hook, setup, discovery, escalation×4, twist, escalation-2026, escalation-regional, insight-transparencia, insight-síntesis, next_curiosity, payoff).
- **Shots (storyboard de planeación):** 45 (el render real los subdivide automáticamente en sub-shots de 3-8s vía `shotsForSpan()`).
- **Distribución final por asset class:**

| Categoría | # | Notas |
|---|---|---|
| TEXT | 17 | Tarjetas determinísticas (citas, hedges, datos duros) |
| AI_RECREATION | 11 | Atmósfera + escenas humanas no documentales + síntesis conceptual — ver sección 14 para las 3 a generar primero |
| DETERMINISTIC | 13 | Mapas, diagramas, línea de tiempo — incluye los 4 shots resueltos vía fallback en `bbde376` (b3-s1, b3-s3, b7-s1, b10-s2) |
| STOCK_REAL | 4 | Pexels, licencia `CLEARED` — incluye b9-s2 (resuelto en `bbde376`) |
| REAL_DOCUMENTARY | 0 | Se resolvieron todos los `NEEDS_REVIEW` hacia fallbacks seguros (ver sección 10) — no hay ningún shot pendiente de una foto real específica sin licencia confirmada |

## 8. Qué está RESUELTO — no volver a investigar

- Interpretación institucional del DAI (asentamiento con fuerte componente ritual) — `ESTABLISHED`.
- Hallazgo de estructuras rectangulares 2026 (Karul, ~1,500 m², norte del núcleo, evaluadas como *posiblemente* residenciales, análisis de suelo pendiente) — `RECENT_FINDING`, hedge preservado.
- Göbekli Tepe como parte de la red Taş Tepeler / Karahan Tepe como "sitio hermano" — `ESTABLISHED`.
- Los 5 shots `NEEDS_REVIEW` de licencias — **resueltos** (ver sección 10). No hay que volver a buscar licencias de Wikimedia Commons para estos 5 shots salvo que alguien confirme manualmente las 2 candidatas documentadas (ver `licensingCandidate` en b3-s1/b3-s3 del storyboard).
- Coordenadas — 2 intentos de verificación agotados (ver sección 11). No seguir buscando salvo que cambie el bloqueo de red.
- Paper de Gresky/Clare septiembre 2026 — 2 intentos dirigidos agotados (ver sección 9). No seguir buscando.

## 9. Qué está explícitamente NO VERIFICADO — nunca convertir en hecho

- **Paper de Gresky/Clare (DAI, ~21 sept 2026) sobre restos humanos/prácticas funerarias en Göbekli Tepe: NOT VERIFIED.** Dos intentos de búsqueda dirigida (inglés + alemán), sin resultado. Una afirmación de "dos tumbas con cuatro esqueletos" que apareció en un resumen agregado de búsqueda fue investigada y **descartada explícitamente** — no tiene respaldo en ninguna fuente real, contradice el consenso documentado ("no complete burials known at Göbekli Tepe"). El único estudio real y vigente sobre restos humanos sigue siendo Gresky, Haelm & Clare (2017), *Science Advances*, DOI 10.1126/sciadv.1700564 (culto al cráneo, sin enterramientos formales). **El guion v.003 ya trata esto correctamente (beat-10, transparencia metodológica) — no cambiar.**
- **Coordenadas de alta precisión** (37°13'23.6712"N, 38°55'20.5104"E, atribuidas al documento de nominación UNESCO `whc.unesco.org/document/168743`): señal secundaria fuerte (coincide con el valor que el usuario propuso originalmente) pero **nunca leída de primera mano** — `whc.unesco.org` bloqueado por el proxy de red en los 3 intentos hechos. El storyboard usa 37.22°N/38.92°E (~1km) y así debe quedarse hasta que alguien sin este bloqueo de red confirme el documento directamente.
- Cualquier otra cifra, cita o hallazgo 2026 que no aparezca explícitamente citado con `sourceId` en `research-pack-002.json` no debe tratarse como verificado.

## 10. Estado de licencias/fallbacks (storyboard v.003)

| Shot | Resolución activa | Categoría | Licencia |
|---|---|---|---|
| b1-s2, b5-s1, b8-s2 (STOCK_REAL originales) | Sin cambios desde v.003 | STOCK_REAL | Pexels License — `CLEARED` |
| b3-s1 (pilar T) | Diagrama esquemático (fallback activo) | DETERMINISTIC | No aplica (sin archivo externo) |
| b3-s3 (relieve animal) | Silueta esquemática (fallback activo) | DETERMINISTIC | No aplica |
| b7-s1 (estructura doméstica) | Diagrama de planta comparativo (fallback activo) | DETERMINISTIC | No aplica |
| b9-s2 (Karahan Tepe) | Stock genérico (no pretende ser la foto literal del sitio) | STOCK_REAL | Pexels License — `CLEARED` |
| b10-s2 (restos humanos) | Diagrama esquemático abstracto (fallback activo, NUNCA foto ni IA) | DETERMINISTIC | No aplica |

**0 assets `NOT_CLEARED`. 0 `NEEDS_REVIEW` bloqueantes.** Quedan documentadas 2 candidatas de Wikimedia Commons (`licensingCandidate` en b3-s1 y b3-s3) como posible actualización futura — **no son necesarias para producir el video**, son solo una nota para quien quiera mejorar esos 2 shots más adelante confirmando la licencia manualmente (`commons.wikimedia.org` está bloqueado en este entorno).

## 11. Estado de coordenadas y limitación de precisión

- **Valor activo en el storyboard (`b2-s1`):** `latitude: 37.22, longitude: 38.92` (~1 km de precisión).
- **Por qué no hay más precisión:** `whc.unesco.org` (UNESCO), `commons.wikimedia.org`, `www.wikidata.org` y `en.wikipedia.org` están bloqueados (`EGRESS_BLOCKED`) por el proxy de red de este entorno sandbox — no es una limitación de la investigación, es una limitación de red de este entorno concreto.
- **Candidato de alta precisión documentado, NO adoptado:** 37°13'23.6712"N, 38°55'20.5104"E — ver sección 9.
- **Si otro agente tiene acceso de red sin este bloqueo:** puede intentar leer `https://whc.unesco.org/document/168743` directamente y, si confirma el valor, actualizar `b2-s1.verifiedCoordinates` en el storyboard (con nota de la fuente exacta) — eso SÍ sería una actualización legítima, no una re-investigación redundante.

## 12. Cost model actual (proyección, cero gasto real hasta ahora)

| Partida | Cálculo | Costo |
|---|---|---|
| TTS (ElevenLabs) | 11,629 caracteres × $0.10/1k | **$1.163** |
| Imágenes IA (11 shots `AI_RECREATION`, calidad `medium`) | 11 × $0.05 | **$0.55** |
| Imágenes IA (calidad `high`, estimado) | 11 × ~$0.09–0.11 | ~$0.99–1.21 |
| Stock real (Pexels), determinístico, música, render | — | $0 |
| **Total proyectado — calidad medium** | | **≈ $1.71** |
| **Total proyectado — calidad high** | | **≈ $2.15–2.37** |

Techo ya configurado en código: `LONG_FORM_MAX_TOTAL_USD = $12`. Ambos escenarios quedan muy por debajo. **Nada de esto se ha gastado — es proyección.**

## 13. Bloqueos técnicos actuales (sin valores de credenciales)

- `OPENAI_API_KEY` — **no configurada** en este sandbox. Bloquea la generación real de imágenes (necesaria para Visual Test V2 y para todos los shots `AI_RECREATION`).
- `ELEVENLABS_API_KEY` — no configurada. Bloquea TTS real.
- `PEXELS_API_KEY` — no configurada. Bloquea footage/imágenes de stock reales.
- `ANTHROPIC_API_KEY` — no configurada. No es necesaria para este video (el guion ya está escrito a mano), pero bloquearía `documentary-script.ts` si se quisiera generar un guion real para un video futuro.
- Credencial de Supabase service-role — no configurada (solo `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` presentes en `.env.local`). Necesaria para subir el output final a Storage en un run real (el orquestador ya trae un mock local de Storage vía HTTP para modo simulation).
- **Gate de seguridad de código** (`mode.ts`): incluso con todas las credenciales presentes, el modo `real` exige explícitamente `--mode=real` **y** la variable `LONG_FORM_REAL_RUN_CONFIRM=YES_SPEND_REAL_MONEY` (string exacto). Sin ambos, es estructuralmente imposible llamar una API paga desde el orquestador.
- **No pedir ninguna de estas claves en el chat** — instrucción explícita y reiterada del usuario a lo largo de todo este proyecto.

## 14. VISUAL TEST V2 — qué generar primero

**Toda esta sección ahora vive también como código real y ejecutable, no solo como texto:** `src/lib/video/long-form/visual-test-v2.ts` (manifest tipado + idempotencia) y `content/long-form/gobekli-tepe-001/visual-test-v2-manifest.json` (el manifest ya materializado con los prompts finales exactos). El texto de abajo describe lo mismo que ese código — si difieren, **el código y el JSON generado mandan** (regenerar el JSON con el comando de la sección 16 si se edita `visual-test-v2.ts`).

Se seleccionaron **3 shots `AI_RECREATION`** de `gobekli-storyboard-003.json`, elegidos para cubrir los 3 retos técnicos/editoriales distintos del video (no 3 variaciones del mismo tipo de toma):

1. **b1-s4** — establishing shot atmosférico (abre el hook, se ecoa en b13-s3 — valida el look base de todo el documental).
2. **b4-s2** — escena humana en silueta (valida la regla más delicada de la Visual Bible: cooperación humana sin rostro/técnica/herramienta específica identificable).
3. **b8-s5** — recreación condicional del hallazgo 2026 (el shot de mayor sensibilidad factual entre los `AI_RECREATION`: valida que una hipótesis con hedge se pueda ilustrar sin sugerir visualmente más certeza de la que hay).

### Parámetros técnicos comunes (los 3)

- `model: "gpt-image-2"`
- `size: "1536x1024"` (landscape 16:9)
- `quality: "medium"`
- Proveedor real: `src/lib/providers/image/openai.ts` (ya integrado, soporte landscape ya construido en Fase A)

### Identidad visual compartida (obligatoria en los 3 prompts)

Realismo fotográfico documental (nunca "pintura" ni look genérico de IA) · iluminación natural únicamente (amanecer/atardecer/luz difusa) · tonos tierra cálidos con sombras frías desaturadas · grano de película sutil · composición anamórfica · cero elementos modernos · sin texto ni marca de agua. (Ver `atomivid-long-form-visual-bible-v1.md` sección 3 para el detalle completo.)

### Prompt 1 — b1-s4 (establishing shot)

```
Wide cinematic establishing shot of the Anatolian highlands (Germuş
mountains) at dawn, ~11,000 years ago (Pre-Pottery Neolithic). Rolling
semi-arid hills under a vast pale gold sky, dry grasses and scattered
stone outcrops, absolutely no modern structures, roads, or present-day
vegetation patterns. Photographic documentary realism, natural light
only, warm earth-tone color grading with desaturated cool shadows,
subtle film grain, anamorphic widescreen composition, atmospheric haze
suggesting deep time and vast scale. No people, no text, no watermark.
```
Negativo: *no modern buildings, no roads, no power lines, no contemporary clothing, no text overlays, no fantasy elements, no aliens, no futuristic technology*

### Prompt 2 — b4-s2 (escena humana, silueta)

```
Cinematic wide shot at dusk: distant silhouettes of a small group of
people working together on a hillside near massive half-buried stone
shapes, scale emphasized by distance and low warm light. Figures are
anonymous silhouettes — no visible clothing detail, tools, or specific
activity that could be mistaken for a documented technique. Mood of
quiet, effortful cooperation, not action. Photographic documentary
realism, warm dusk color grading, subtle atmospheric haze, film grain,
anamorphic widescreen. No text, no watermark.
```
Negativo: *no visible tools, no specific construction technique, no visible clothing details, no ropes or pulleys shown explicitly, no close-up faces, no modern elements*

### Prompt 3 — b8-s5 (recreación condicional 2026)

```
Cinematic wide shot: a domestic scene in silhouette/middle distance —
anonymous figures near small rectangular structures — with massive
monumental stone enclosures visible in the background under warm light.
Composition should read as speculative and atmospheric, not as
documentary proof: soft focus on the rectangular structures, no specific
architectural detail claimed. Photographic documentary realism, warm
color grading, subtle film grain, anamorphic widescreen, contemplative
mood. No text, no watermark.
```
Negativo: *no close-up architectural detail on the rectangular structures (evita implicar una planta confirmada), no visible faces, no modern elements, no text overlays implying certainty*

**Regla obligatoria para b8-s5 en el render final:** este shot nunca va solo — siempre acompañado en pantalla por la tarjeta de texto del hedge (`b8-s4`, "evaluadas como posiblemente residenciales — no confirmadas"). Es una regla de montaje, no de generación de imagen.

### Idempotencia y cost guard (ya implementados, no solo prometidos)

- Cada shot tiene un `idempotencyKey` = hash SHA-256 de (shotId, modelo, tamaño, calidad, prompt, prompt negativo). El `outputPath` incluye esa clave. Si se llama dos veces con los mismos parámetros, `shouldGenerate()` ve que el archivo ya existe y **se salta la llamada** — no hay forma de generar (ni cobrar) la misma imagen dos veces por accidente.
- `video-cost-guard.ts` bloquea CUALQUIER gasto que llevaría la categoría `visual_test_v2` por encima de $0.50, o el total acumulado de VIDEO #001 por encima de $3.00 — el ledger es persistente en disco (`.atomivid-state/long-form/gobekli-tepe-001-cost-ledger.json`, gitignored), así que esto se cumple incluso si el proceso se reinicia entre llamadas.
- **Ejecutor listo, NO corrido:** `scripts/generate-visual-test-v2.ts` — implementa exactamente este flujo (shouldGenerate → assertCanSpend → generar → recordSpendToDisk). Ver comando exacto en sección 16.

### Costo estimado

3 imágenes × $0.05 (medium) = **$0.15** (calculado por el propio manifest — ver `estimatedTotalUsd` en `visual-test-v2-manifest.json`). Muy por debajo del tope de $0.50 autorizado para este checkpoint.

### Criterios para aprobar/rechazar cada imagen

**Aprobar si:**
- Cumple la identidad visual compartida (realismo documental, luz natural, grading cálido/frío, grano sutil, anamórfico).
- Cero elementos modernos o anacrónicos (caminos, cableado, ropa contemporánea, metal moderno, escritura).
- Sin texto ni marca de agua incrustados.
- (b4-s2, b8-s5) Figuras humanas en silueta/distancia, sin rostro identificable, sin técnica/herramienta específica no verificada.
- (b8-s5) Se lee como escena atmosférica/especulativa, NO como fotografía de un hallazgo confirmado — sin detalle arquitectónico específico que sugiera una planta ya validada.
- Las 3 imágenes se sienten parte de la misma serie (coherencia de estilo entre ellas).

**Rechazar (y regenerar o revisar el prompt) si:**
- Aparece cualquier elemento moderno/anacrónico.
- Aparece texto o marca de agua.
- Un rostro humano queda identificable en b4-s2 o b8-s5.
- b8-s5 se lee como si documentara un hecho confirmado (p. ej. planta arquitectónica detallada y nítida).
- El estilo de alguna de las 3 se aparta claramente de las otras dos (rompe la identidad de serie).

## 15. Instrucciones exactas para continuar después de aprobar las 3 imágenes

```
Visual Test V2 aprobado por el usuario
  → npx tsx scripts/generate-visual-test-v2.ts --confirm=YES_SPEND_REAL_MONEY
     (genera las 3 imágenes reales — idempotente, respeta el cost guard)
  → TTS (ElevenLabs, real, requiere ELEVENLABS_API_KEY + --mode=real +
     LONG_FORM_REAL_RUN_CONFIRM=YES_SPEND_REAL_MONEY)
  → Resolución de assets restantes vía
     produce-long-form-video.ts --mode=real --script=... --storyboard=...
     (asset-resolver.ts + storyboard-shots.ts + real-graphics.ts: Pexels
     para los 4 STOCK_REAL, gráficos reales para los 13 DETERMINISTIC, y
     los 8 AI_RECREATION restantes — de los 11 totales, solo 3 se validan
     en el Visual Test V2; los otros 8 se generan recién después de la
     aprobación, con el mismo estilo VIDEO_001_VISUAL_STYLE ya validado)
  → Render (LongFormDoc, 1920x1080 — render.ts ya corre
     assertRenderInputValid() antes de renderizar, detiene con error claro
     si algo no cuadra en vez de producir un video roto)
  → QC: assertVideoQc() + detectAnomalousSilences() + 
     assertProductionReportForRealRun() (long-form-qc.ts, contra el .mp4
     y el report.json reales) + inspección visual de frames
  → Entrega del MP4 final al usuario
  → NO publicar todavía — ninguna publicación, deploy, ni distribución
     pública sin autorización explícita adicional del usuario
```

No saltarse ningún paso de esta secuencia. No generar el resto de imágenes IA antes de que el usuario apruebe explícitamente las 3 del Visual Test V2.

## 16. Comandos exactos del proyecto

```bash
# Instalar dependencias
npm install

# Tests unitarios (550 tests esperados, todos deben pasar)
npm run test:unit

# Typecheck
npm run typecheck

# Lint
npm run lint

# Pipeline de prueba end-to-end (fixtures, Shorts 9:16 — no confundir con Long Form)
npm run test:pipeline

# Long Form — modo simulation, guion fixture genérico (comportamiento original, sin --storyboard)
npx tsx scripts/produce-long-form-video.ts \
  --script=content/long-form/gobekli-tepe-001/gobekli-script-003-current.json \
  --output=/ruta/salida.mp4

# Long Form — modo simulation CON el storyboard curado real (45 shots reales,
# gráficos reales) — RECOMENDADO para validar el pipeline completo antes de
# gastar dinero. Cero costo, sigue en modo simulation.
npx tsx scripts/produce-long-form-video.ts \
  --script=content/long-form/gobekli-tepe-001/gobekli-script-003-current.json \
  --storyboard=content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json \
  --output=/ruta/salida.mp4

# Long Form — modo real (SOLO tras autorización explícita del usuario y con
# las credenciales configuradas; nunca ejecutar esto sin esa autorización).
# --storyboard es lo que hace que el render use los 45 shots curados reales
# en vez del ciclo genérico — para la producción real de VIDEO #001 SIEMPRE
# se debe pasar junto con --script.
LONG_FORM_REAL_RUN_CONFIRM=YES_SPEND_REAL_MONEY npx tsx scripts/produce-long-form-video.ts \
  --mode=real \
  --script=content/long-form/gobekli-tepe-001/gobekli-script-003-current.json \
  --storyboard=content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json \
  --output=/ruta/salida.mp4

# Visual Test V2 — genera las 3 imágenes reales de prueba (SOLO tras
# autorización explícita del usuario y con OPENAI_API_KEY configurada;
# nunca ejecutar esto sin esa autorización). Idempotente y con cost guard.
npx tsx scripts/generate-visual-test-v2.ts --confirm=YES_SPEND_REAL_MONEY

# Regenerar el manifest JSON del Visual Test V2 si se edita visual-test-v2.ts
# (gratis, no llama a ninguna API — solo materializa el manifest a disco)
node --import tsx -e "
import { buildVisualTestV2Manifest } from './src/lib/video/long-form/visual-test-v2.ts';
import fs from 'node:fs';
fs.writeFileSync(
  'content/long-form/gobekli-tepe-001/visual-test-v2-manifest.json',
  JSON.stringify(buildVisualTestV2Manifest(), null, 2) + '\n',
);
" 2>/dev/null || echo "si el eval falla por resolución de módulos, escribir un archivo .mjs temporal que importe y llame la función, y correrlo con node --import tsx <archivo>"
```

## 17. Qué NO debe tocar el siguiente agente

- **El pipeline 9:16 (Shorts):** `remotion/VerticalReel.tsx`, `src/lib/video/generate-video.ts`, y cualquier ruta bajo `src/app/api/generate/` — cero relación con Long Form, cero necesidad de tocarlos para este video.
- **`src/lib/video/long-form/mode.ts`** — el gate de seguridad. No relajarlo, no añadir atajos, no hacer que `simulation` pueda leer credenciales reales.
- **Los archivos históricos versionados** (`gobekli-script-002-final.*`, `gobekli-storyboard-001.json`, `gobekli-storyboard-002-hybrid.json`, `gobekli-production-plan-001.md`, `gobekli-visual-test-001.md`) — nunca sobreescribirlos ni borrarlos. Si algo cambia, se crea una nueva versión (`-004`, etc.), nunca se edita una versión ya aprobada in-place.
- **No pedir ninguna API key en el chat.** Si falta una credencial, reportarlo como bloqueo, igual que se ha hecho hasta ahora.
- **No generar imágenes, no hacer TTS, no renderizar, no llamar ninguna API paga** sin autorización explícita y sin el gate de `--mode=real` + `LONG_FORM_REAL_RUN_CONFIRM`.
- **No crear PR, no hacer merge, no hacer deployment** sin que el usuario lo pida explícitamente.
- **No reabrir la tesis, duración, número de beats, ni la estrategia híbrida** del guion/storyboard v.003 salvo que aparezca un error factual material nuevo (no uno ya investigado y cerrado en las secciones 8-9).
- **No subir los topes de `video-cost-guard.ts`** (`VISUAL_TEST_V2_MAX_USD=$0.50`, `VIDEO_001_HARD_STOP_USD=$3.00`) sin una autorización explícita nueva del usuario — son específicos de VIDEO #001, no del sistema genérico de Long Form.
- **No editar a mano el ledger de costo** (`.atomivid-state/long-form/gobekli-tepe-001-cost-ledger.json`, si llega a existir) — es el registro real de gasto, solo debe modificarse vía `recordSpendToDisk()` después de una llamada paga real confirmada.
- **No ejecutar `scripts/generate-visual-test-v2.ts` ni ningún run con `--mode=real`** sin la autorización explícita del checkpoint correspondiente (ver sección 15) — ambos exigen `--confirm=YES_SPEND_REAL_MONEY` / `LONG_FORM_REAL_RUN_CONFIRM` precisamente para que no se disparen sin querer, pero la intención de no correrlos sigue siendo una decisión humana, no solo técnica.

## 18. Detalles que, si se pierden, causarían gasto duplicado, regresión, uso accidental de fixtures, o pérdida de trazabilidad

- **El modo por defecto del orquestador es `simulation`.** Si se omite `--mode=real`, todo corre con fixtures y cero costo — esto es intencional y seguro, pero si alguien *cree* que corrió en real y en realidad corrió en simulation, podría pensar erróneamente que ya se gastó dinero cuando no fue así (o viceversa: nunca asumir que un run fue "real" sin ver `--mode=real` explícito en el comando Y el reporte JSON de salida, que incluye `paidApisCalled` calculado programáticamente — revisar siempre ese campo, no asumir).
- **El guion correcto a usar es `gobekli-script-003-current.json`**, no `gobekli-script-002-final.json`. Usar el archivo equivocado produciría un video con la tesis/duración/beats antiguos (v.002), no el aprobado.
- **El storyboard correcto es `gobekli-storyboard-003.json`** (con las licencias ya resueltas en `bbde376`), no `-001` ni `-002-hybrid`. Los shots de esas versiones antiguas no reflejan la resolución de licencias ni el contenido 2026.
- **b8-s5 nunca se muestra sin su hedge textual (`b8-s4`) en el mismo tramo** — perder esta regla de montaje convertiría una hipótesis condicional en una afirmación visual no respaldada, exactamente lo que este proyecto ha evitado deliberadamente en cada checkpoint.
- **La distinción REAL_DOCUMENTARY=0 en el storyboard v.003 es intencional, no un error** — los 5 shots que originalmente iban a ser fotos reales específicas se resolvieron hacia fallbacks seguros (DETERMINISTIC/STOCK_REAL) precisamente porque no se pudo confirmar licencia. No "arreglar" esto sustituyendo por fotos sin verificar la licencia primero.
- **Cada claim del guion lleva `sourceIds` trazables a `research-pack-002.json`.** Si se edita el guion, mantener esa trazabilidad — es el mecanismo que ha permitido, en cada checkpoint, distinguir lo verificado de lo no verificado sin perder el hilo.
- **El techo de costo ya configurado es `LONG_FORM_MAX_TOTAL_USD=12`** — la proyección actual (~$1.71-2.37) deja margen amplio; no es necesario ni se ha pedido subir ese techo.
- **RESUELTO (checkpoint posterior a `911f8ba`):** la síntesis TTS ahora SÍ tiene caché/idempotencia persistente por beat — ver `src/lib/video/long-form/tts-cache.ts`, wireado en `produce-long-form-video.ts` automáticamente cuando se pasa `--storyboard`. Un crash a mitad de sintetizar los 13 beats en modo real, seguido de un re-run, ya NO resintetiza (ni recobra) los beats que quedaron `COMPLETED` con un archivo válido — solo los que faltaban o quedaron en un estado incierto se vuelven a intentar (y un estado `STARTED` sin `COMPLETED` NUNCA se reintenta solo: lanza `TtsUncertainCostStateError` y detiene la ejecución). Ver la tabla de código nueva más abajo y la sección 20.
- **El proxy de red de este entorno bloquea ~15+ dominios** (whc.unesco.org, en.wikipedia.org, wikidata.org, commons.wikimedia.org, dainst.org, dainst.blog, mdpi.com, hurriyetdailynews.com, arkeonews.net, ancient-origins.net, dailysabah.com, researchgate.net, aa.com.tr, arkeofili.com, theothertour.com, popular-archaeology.com, thearchaeologist.org, idw-online.de, archaeologie-online.de) — esto es una limitación de ESTE entorno sandbox, no del proyecto. Un agente en otro entorno podría tener acceso directo y debería aprovecharlo para las 2 verificaciones pendientes (sección 9), pero no debe asumir que el bloqueo sigue vigente sin comprobarlo primero.

## 19. Resultado del dry-run end-to-end (--script + --storyboard, modo simulation)

**Estado: COMPLETADO Y VERIFICADO.** Corrió ~17.7 minutos (`renderMs: 1,062,384`) en modo `simulation` — cero costo. Confirma que la integración `--storyboard` funciona de punta a punta, incluida la composición Remotion real.

Comando ejecutado:
```
npx tsx scripts/produce-long-form-video.ts \
  --script=content/long-form/gobekli-tepe-001/gobekli-script-003-current.json \
  --storyboard=content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json \
  --output=<ruta temporal>
```

**Reporte del orquestador (`report.json`):**
```json
{
  "mode": "simulation",
  "topic": "Göbekli Tepe: el sitio que sigue obligándonos a corregir la historia",
  "isFixtureContent": false,
  "scriptSource": "content/long-form/gobekli-tepe-001/gobekli-script-003-current.json",
  "storyboardSource": "content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json",
  "actualDurationSeconds": 660.14,
  "beatCount": 13,
  "shotCount": 45,
  "distinctShotTypes": 6,
  "shotTypesUsed": ["text", "stock_video", "ken_burns_image", "map", "diagram", "stock_image"],
  "providersUsed": { "voice": "fixture", "footage": "fixture", "music": "fixture", "image": "fixture" },
  "paidApisCalled": false,
  "imageCostSpentUsd": 0
}
```

**Lo que esto confirma, punto por punto (ver sección 8 del pedido original de este checkpoint):**
- ✅ **Los 45 shots del storyboard llegaron correctamente hasta la composición** — `shotCount: 45` (antes de este checkpoint, sin `--storyboard`, el pipeline generaba su propio conteo genérico sin relación con el storyboard curado — ver el "hallazgo mayor" en la sección 4).
- ✅ `beatCount: 13` — coincide exactamente con el guion v.003.
- ✅ `paidApisCalled: false` — la invariante interna del propio script (`if (paidApisCalled && args.mode === "simulation") throw ...`) no se disparó, y el propio reporte lo confirma.
- ✅ Duración real narrada (660.14s) prácticamente idéntica a la estimada en el guion (659.6s) — la síntesis fixture y el escalado del storyboard a la duración real funcionan correctamente juntos.
- ✅ Masterización de loudness corrió sin errores (`-16 LUFS` objetivo alcanzado: de -20.96 a -16.05 LUFS).

**QC post-render REAL sobre el .mp4 resultante (`long-form-qc.ts`, contra el archivo real, no simulado):**
```
probeVideoFile: { hasVideoStream: true, hasAudioStream: true, width: 1920, height: 1080, fps: 30, durationSeconds: 660.2 }
evaluateVideoProbe(...): NINGÚN problema — pasa QC (16:9, 1920x1080, 30fps, audio presente, duración dentro de tolerancia)
detectAnomalousSilences(..., 5): 0 silencios de más de 5s detectados
evaluateProductionReportForRealRun(...): detecta correctamente "not_real_mode" y "no_paid_apis_called" — CORRECTO, porque
  este dry-run es de modo simulation, no una entrega real; confirma que el chequeo funciona como diseñado
  (atraparía exactamente este caso si alguien intentara entregar un run de simulation como si fuera producción real).
```

## 20. Idempotencia TTS entre procesos (checkpoint posterior a `911f8ba`)

**Estado: RESUELTO.** Antes de este checkpoint, el único gap documentado en la sección 18 era: si ElevenLabs sintetiza correctamente algunos beats en modo real y el proceso falla/crashea a mitad de camino, un re-run naive volvería a sintetizar (y a cobrar) TODOS los beats, no solo los pendientes. Eso ya no ocurre.

**Diseño — caché persistente por beat con identidad determinística:**

- Módulo nuevo: `src/lib/video/long-form/tts-cache.ts` (20/20 tests). Cada beat TTS tiene una identidad = hash SHA-256 de `{ videoId, beatId, text, voiceId, modelId, voiceSettingsJson, language, providerName }`. `voiceId`/`modelId`/`voiceSettingsJson` vienen de `getVoiceIdentity()` en `src/lib/ai/voice.ts` (nuevo, 4/4 tests) — incluye `stability`, `similarity_boost`, `style`, `use_speaker_boost`, pero **nunca** `speed` (es un ajuste por llamada, no de identidad de voz).
- Ciclo de vida por registro (`.atomivid-state/long-form/tts-cache/<videoId>/<key>.json` + `<key>.<ext>` de audio, gitignored):
  1. **(sin registro)** → hay que generar.
  2. **STARTED** — se escribe **antes** de llamar al proveedor real. Si el proceso muere aquí, el siguiente run encuentra `STARTED` sin `COMPLETED` y lanza `TtsUncertainCostStateError` — **nunca reintenta solo**, porque no se sabe si ElevenLabs ya cobró. Detiene la ejecución para revisión manual (dashboard de ElevenLabs) antes de arriesgar doble cobro.
  3. **COMPLETED** — se escribe después de guardar el audio en disco, con checksum SHA-256, duración, palabras (timings), costo registrado y metadata. Un siguiente run con la MISMA identidad y cuyo archivo pasa `validateCachedAudioFile` (existe, no vacío, checksum coincide) → **REUSE**, cero llamada a ElevenLabs.
- Si cambia texto, voz, modelo o parámetros de voz relevantes → identidad distinta → clave distinta → nueva generación (nunca reutiliza audio incorrecto).
- **El proveedor fixture (`voiceProvider.name === "fixture"`) nunca toca la caché** (ni lee ni escribe) — bypass estructural, no solo un `if`: así es arquitectónicamente imposible que contenido de simulación quede marcado como una síntesis real `COMPLETED`.
- Integración con el cost guard de VIDEO #001: `synthesizeBeatNarrationCached` recibe un `TtsCostGuard` opcional (`estimateCostUsd`/`assertCanSpend`/`recordSpend`); `scripts/produce-long-form-video.ts` lo conecta automáticamente al ledger de costo (`video-cost-guard.ts`, hard stop $3.00) solo cuando `storyboard.videoId === "gobekli-tepe-001"` — el módulo de caché en sí queda genérico/reutilizable para otros videos futuros.
- Wireado vía inyección de dependencia: `buildLongFormTimeline()` ahora acepta un 5º parámetro opcional `synthesizeBeat` (default = comportamiento anterior sin caché) — cuando se ejecuta con `--storyboard`, `produce-long-form-video.ts` pasa la versión cacheada; sin `--storyboard`, el comportamiento es 100% idéntico al de antes de este checkpoint (incluido: sin caché).

**Tests añadidos (24 nuevos, todos pasando):** `tts-cache.test.ts` (20) cubre exactamente los 10 escenarios pedidos — beat nuevo, beat completado→reuse, restart de proceso→reuse persistente, texto cambiado→nueva generación, voz/modelo/parámetros cambiados→nueva generación (3 sub-casos), archivo faltante/corrupto→no reuse (2 sub-casos), estado incierto (`STARTED`)→no retry automático (2 sub-casos), múltiples beats→solo genera los faltantes, cost guard cuenta solo llamadas nuevas (2 sub-casos), simulation/fixture nunca marca `COMPLETED` real (2 sub-casos) — más 6 tests unitarios de `computeTtsCacheKey`/`validateCachedAudioFile`. `voice.test.ts` (4) valida `getVoiceIdentity()`: nunca incluye `speed`, incluye los 4 parámetros relevantes, es determinística, siempre trae `voiceId`/`modelId` no vacíos.

**Validación de esta checkpoint:** `npm run typecheck` limpio, `npm run lint` limpio (0 warnings), `npm run test:unit` 645/645, `npm run build` exitoso (mismo warning preexistente y no relacionado de `avatar/pipeline.ts` que ya existía antes de este checkpoint). `git diff --stat` confirma cero cambios en `remotion/VerticalReel.tsx`, `src/lib/video/generate-video.ts` y `src/app/api/generate` — el pipeline 9:16 queda intacto. Cero llamadas pagadas: no se invocó ElevenLabs, OpenAI Images, Pexels, Anthropic ni HeyGen reales en ningún momento de este checkpoint.

**Archivo de salida:** se generó en el directorio temporal de esta sesión y se descartó al terminar (no es un artefacto de repositorio) — el comando de arriba es reproducible por cualquiera en cualquier momento, sin gasto, para volver a verificarlo.

## 21. Puente seguro de producción en Vercel para Visual Test V2 (DRY_RUN/PREFLIGHT — checkpoint posterior a `e250b9f`)

**Situación:** `OPENAI_API_KEY` ya está configurada como Environment Variable del proyecto ATOMIVID en Vercel, pero el sandbox de este agente nunca tiene acceso a ella (entornos separados). Este checkpoint construye el mecanismo mínimo para ejecutar el Visual Test V2 **dentro** de un runtime de Vercel, donde `process.env.OPENAI_API_KEY` sí existe — sin autorizar todavía ninguna llamada real.

**Arquitectura elegida (la más pequeña posible, cero infraestructura nueva):** un Route Handler de Next.js server-side, `POST /api/long-form/visual-test-v2`, que reutiliza al 100% los módulos ya existentes y validados (nada duplicado):
- `assertLongFormAccess` (`access.ts`) para autorización — el mismo gate de beta que ya usa el resto de Long Form: `LONG_FORM_ENABLED=true` + allowlist por `id`/`email` (`LONG_FORM_ALLOWLIST_USER_IDS`/`LONG_FORM_ALLOWLIST_EMAILS`). Sin encender ambas cosas para la cuenta del owner, el endpoint devuelve 403 sin importar qué más esté configurado.
- `buildVisualTestV2Manifest`/`shouldGenerate` (`visual-test-v2.ts`) para los 3 shots aprobados (`b1-s4`, `b4-s2`, `b8-s5`) y la idempotencia por archivo en disco — **sin tocar los prompts ni el estilo**.
- `assertCanSpend`/`readCostLedgerFromDisk` (`video-cost-guard.ts`) para el tope de $0.50 (categoría `visual_test_v2`) y el hard stop de $3.00 (VIDEO #001).

Archivo nuevo con toda la lógica (testeable sin Next.js/Supabase, mismo patrón que `evaluateRenderStart`/`render-guard.ts`): **`src/lib/video/long-form/visual-test-v2-runtime.ts`**. El route handler (**`src/app/api/long-form/visual-test-v2/route.ts`**) es solo el adaptador: obtiene `user` de Supabase y el body del `Request`, y delega toda la decisión en `evaluateVisualTestV2Request(user, rawBody)`.

**Autorización:** `POST` sin sesión → `401`. Con sesión pero sin `LONG_FORM_ENABLED=true` o sin estar en la allowlist → `403` (mensaje genérico, no revela cuál de las dos condiciones falló). Nunca se acepta un request anónimo ni de un usuario no autorizado.

**Acceso a `OPENAI_API_KEY` sin exponerla:** el runtime lee únicamente `process.env.OPENAI_API_KEY` (nunca hardcoded) y solo para calcular un booleano (`openaiApiKeyAvailable`) — el valor de la key JAMÁS se lee en ninguna otra parte del código nuevo, nunca se incluye en la respuesta JSON, nunca se pasa a `console.log`. Test dedicado (`visual-test-v2-runtime.test.ts`) confirma con un secreto falso que `JSON.stringify(report)` nunca lo contiene.

**Cómo funciona DRY_RUN:** el body aceptado es EXCLUSIVAMENTE `{ "mode": "dry_run" }` — cualquier otra clave (prompt, count, shots...) o cualquier otro valor de `mode` se rechaza (`400`), así que el cliente estructuralmente no puede inyectar un prompt arbitrario ni pedir una cantidad de imágenes distinta a las 3 aprobadas. Con autorización + body válido, `runVisualTestV2Preflight()`:
1. construye el manifest real y valida que sean exactamente los 3 shots aprobados y que el costo estimado (~$0.15) no supere el tope de $0.50;
2. lee (sin escribir) el cost ledger persistido y valida contra `assertCanSpend` — si ya se excedería el tope o el hard stop, reporta `withinCostGuard: false` con el motivo, pero nunca lanza ni bloquea el proceso;
3. para cada shot, reporta si ya existe el archivo de salida (`shouldGenerate`) — hoy siempre "sí generaría" porque nada se ha generado todavía;
4. reporta `openaiApiKeyAvailable` (booleano, nunca el valor) y `paidApisCalled: false` siempre.

No escribe nada en disco, no llama a ninguna API — es seguro (e idempotente) ejecutarlo repetidas veces.

**Cómo queda bloqueado REAL mode:** `VISUAL_TEST_V2_REAL_MODE_LOCKED = true` en `visual-test-v2-runtime.ts` es una **constante de código**, no una variable de entorno — deliberadamente, para que un env var mal puesto en Vercel (incluida la propia `OPENAI_API_KEY`) nunca pueda activarlo por accidente (mismo criterio que ya usa `LONG_FORM_REAL_RUN_CONFIRM` en `mode.ts`). Más fuerte todavía: **no existe ningún código de generación real** en este módulo ni en el route handler — un test estructural (`route.ts ... no importa ningún proveedor real de imagen`) lee el código fuente de la ruta y confirma que no aparece `openaiImageProvider`, `images.generate` ni `api.openai.com`. Un body con `mode: "real"` se rechaza con `403` (`VisualTestV2RealModeLockedError`) antes de llegar a ninguna otra validación. Habilitar REAL mode requerirá un checkpoint nuevo, explícitamente autorizado, que además escriba el código de generación real (hoy inexistente).

**Cost guard:** reutilizado sin cambios — `VISUAL_TEST_V2_MAX_USD=0.50` y `VIDEO_001_HARD_STOP_USD=3.00` de `video-cost-guard.ts`. El preflight nunca llama a `recordSpend`/`recordSpendToDisk` (no hay gasto real que registrar en DRY_RUN).

**Idempotencia:** reutilizada sin cambios — `shouldGenerate()` de `visual-test-v2.ts` (existencia de archivo en `outputPath`, que ya incluye el hash de `(shotId, modelo, tamaño, calidad, prompt, prompt negativo)`). Un test confirma que llamar el preflight dos veces seguidas da resultados idénticos y no muta el ledger ni el estado de "generaría/no generaría".

**Outputs previstos (para cuando se autorice generación real, todavía NO ejecutado):** mismo `outputPath` ya definido por `visual-test-v2.ts` — `content/long-form/gobekli-tepe-001/visual-test-v2/<shotId>-<idempotencyKey>.png`, nombre determinístico que ya incluye el hash de todos los parámetros relevantes. Metadata (`shotId`, prompt/negativePrompt, hash, modelo, tamaño, calidad, costo) queda disponible en el propio manifest y se conserva junto al PNG. **Nota técnica para el siguiente checkpoint (no bloqueante para este):** el filesystem de las funciones serverless de Vercel es efímero — una escritura real ahí (o en `.atomivid-state/`, usado por el cost ledger) no sobrevive entre invocaciones ni despliegues. Antes de autorizar generación real en Vercel, ese siguiente checkpoint deberá decidir un destino durable (p. ej. Supabase Storage para el PNG + una tabla para el ledger) en vez de disco local — DRY_RUN no lo necesita porque no escribe nada.

**Tests (22 nuevos, todos pasando):** `visual-test-v2-runtime.test.ts` cubre los 10 escenarios pedidos — sin autorización→reject, autorizado→preflight permitido, `OPENAI_API_KEY` ausente→visible en el reporte, manifest inválido→reject (más de 3 shots, shotIds incorrectos), costo>$0.50→reject (`withinCostGuard:false`), duplicate/idempotent request→sin doble ejecución, real mode desactivado→imposible generar, secreto nunca en response/log, más un test estructural que confirma que la ruta HTTP no importa ningún proveedor real de imagen. `pipeline 9:16 intacto` verificado con `git diff --stat` (cero cambios en `VerticalReel.tsx`/`generate-video.ts`/`api/generate`).

**Validación de este checkpoint:** `npm run typecheck` limpio, `npm run lint` limpio (0 warnings), `npm run test:unit` 667/667 (645 previos + 22 nuevos), `npm run build` exitoso — la nueva ruta `/api/long-form/visual-test-v2` aparece listada como `ƒ` (server-rendered) en el output de `next build`. Cero llamadas pagadas.

**Qué falta para ejecutar el DRY_RUN en Vercel:**
1. Configurar `LONG_FORM_ENABLED=true` y `LONG_FORM_ALLOWLIST_EMAILS=<email del owner>` (o `LONG_FORM_ALLOWLIST_USER_IDS`) como Environment Variables del proyecto en Vercel — hoy Long Form completo sigue apagado por defecto en producción, así que sin esto el endpoint devuelve 403 aunque el código ya esté desplegado.
2. Hacer login normal en ATOMIVID con la cuenta del owner (autenticación ya existente vía Supabase) para tener una sesión válida al llamar al endpoint.
3. Hacer `POST /api/long-form/visual-test-v2` con body `{"mode":"dry_run"}` y revisar el JSON de respuesta (`openaiApiKeyAvailable`, `shots`, `estimatedTotalUsd`, `withinCostGuard`, `realModeLocked: true`, `paidApisCalled: false`).

**Deployment:** el código de este checkpoint queda completamente preparado y commiteado, pero **NO se ha desplegado**. Si se despliega tal cual (sin las env vars del punto 1), el endpoint existe pero devuelve 403 a cualquiera — REAL generation sigue siendo estructuralmente imposible incluso con `OPENAI_API_KEY` configurada, así que un deployment accidental no puede generar imágenes. Aun así, el despliegue en sí (a producción o preview) requiere la autorización explícita del usuario para el siguiente paso — no se hace en este checkpoint.
