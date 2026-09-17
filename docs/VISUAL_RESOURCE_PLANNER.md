# Planificador visual — imagen generada (OpenAI) integrada al pipeline real

Estado: **implementado y cableado al pipeline real de producción; generación pagada apagada por defecto (`OPENAI_IMAGE_GENERATION_ENABLED=false`); no se hizo ninguna llamada real a OpenAI en esta fase.**

Última actualización: 2026-09-17.

## Por qué existe

El "Visual Director" (`src/lib/video/storyboard/`, fase anterior) ya clasifica cada escena del guion en un `resourceType` (`stock_video` | `generated_image` | `generated_video` | `motion_graphic` | `abstract`) y ya trae un `imagePrompt`/`negativePrompt` en inglés listos para un generador de imágenes. Hasta esta fase, esa clasificación **nunca se usaba** — `generate-video.ts` construía el storyboard solo para loguearlo (`[atomivid:storyboard]`) y seguía usando stock (Pexels/Pixabay) para el 100% de las escenas, sin importar lo que el storyboard recomendara.

Esta fase conecta esa clasificación con una decisión y ejecución reales: para la escena que el Visual Director marcó como candidata a imagen generada (y solo esa), el pipeline intenta de verdad `OpenAIImageProvider` — con límites de costo/cantidad, idempotencia y sin fallback pagado silencioso — y si no aplica o falla, sigue exactamente el mismo camino de stock que ya existía.

## Arquitectura

```
generate-video.ts (bucle por escena/beat)
        │
        ├─ storyboard?.scenes[i]  (Visual Director, ya existente — opcional)
        │
        ▼
visual-resource-planner.ts   ← PURO, sin I/O, testeable sin red
  decideResourceStrategy()     decide stock vs. generación (política conservadora, ver abajo)
  buildScenePlanEntry()        arma la especificación estructurada por escena (id, duración,
                                intención narrativa, tipo de recurso, proveedor, prompt/consulta,
                                9:16, tratamiento de movimiento, estado, costo estimado)
        │
        ▼  (solo si useGeneration === true)
visual-resource-resolver.ts  ← I/O real: Supabase Storage + ImageProvider
  findExistingGeneratedImage() idempotencia: reutiliza un archivo ya generado en un intento
                                anterior del MISMO requestId/escena (list() por prefijo, nunca
                                vuelve a facturar una escena ya resuelta)
  resolveGeneratedImageForScene()
                                si no existe: llama a getImageProvider().generateImage(),
                                valida el archivo (visual-asset-validation.ts), sube a Storage,
                                firma la URL — o lanza, y el llamador cae a stock (nunca a otro
                                proveedor de pago)
        │
        ▼
scenes: Scene[]  (mediaUrl, mediaType:"image", startSeconds, endSeconds)
        │
        ▼
remotion/VerticalReel.tsx — SIN CAMBIOS: Ken Burns (zoom+pan), crossfade, safe areas
        para subtítulos y objectFit:"cover" ya se aplican de forma genérica a
        CUALQUIER Scene, sea de stock o generada — no hizo falta tocar Remotion.
```

Archivos nuevos: `src/lib/video/visual-resource-planner.ts`, `visual-resource-resolver.ts`, `visual-asset-validation.ts`, `scripts/dry-run-visual-plan.ts`, `supabase/migrations/0012_visual_resource_planner.sql`.
Archivos modificados: `src/lib/video/generate-video.ts` (bucle de escenas), `src/lib/video/feature-flags.ts` (2 flags nuevas), `src/lib/billing/usage.ts` (contadores nuevos en `creativeLayer`).

## Política de selección: cuándo se genera (nunca por defecto)

`decideResourceStrategy()` (puro, sin red) solo permite generación si **todas** estas condiciones se cumplen — si falla cualquiera, la escena usa stock:

1. `VISUAL_DIRECTOR_ENABLED=true` — sin esto no hay clasificación semántica por escena, jamás se genera nada.
2. `OPENAI_IMAGE_GENERATION_ENABLED=true` — interruptor global explícito, **independiente** del anterior y de `IMAGE_PROVIDER`.
3. El Visual Director marcó esa escena como `generated_image` o `abstract` (conceptual/simbólica/difícil de encontrar en stock). `stock_video`/`generated_video`/`motion_graphic` nunca son candidatas — `generated_video` es dominio de `VideoProvider`/Runway (ya implementado aparte) y `motion_graphic` no tiene renderizador propio todavía.
4. `scene.confidence >= 0.6` (`MIN_GENERATION_CONFIDENCE`) — una interpretación dudosa del Visual Director no debe gastar dinero.
5. No se alcanzó `MAX_GENERATED_IMAGES_PER_VIDEO` (default 3).
6. No se excedería `MAX_VISUAL_COST_USD` (default 1, ya existente — `checkImageBudget()` en `cost-estimator.ts`).

Además, **solo el primer beat de cada escena** es candidato — como mucho una imagen generada por escena del guion, nunca una por cada sub-plano, para mantener el costo predecible.

## Controles de costo y seguridad (todos ya implementados)

| Control | Mecanismo |
|---|---|
| Generación pagada apagada por defecto | `OPENAI_IMAGE_GENERATION_ENABLED=false` (nuevo) |
| Máximo de imágenes por video | `MAX_GENERATED_IMAGES_PER_VIDEO` (default 3) |
| Máximo de costo visual por solicitud | `MAX_VISUAL_COST_USD` (default 1, ya existente) |
| Rechazo explícito antes de exceder el límite | `decideResourceStrategy()` + `checkImageBudget()` — nunca se llama al proveedor si excedería |
| Sin fallback pagado silencioso | Si la generación falla, el `catch` en `generate-video.ts` SOLO cae a stock (gratis) — nunca a Runway/Beatoven/HeyGen. Verificado por una prueba estructural (`visual-director-integration.test.ts`) que confirma que el bloque catch no menciona ningún otro proveedor de pago. |
| Idempotencia en reintentos | `findExistingGeneratedImage()` busca por prefijo determinístico (`scene-{n}-generated.*`) antes de llamar al proveedor — un reintento del mismo job nunca vuelve a facturar una escena ya resuelta |
| Modo dry-run | `scripts/dry-run-visual-plan.ts` — construye el plan completo (stock vs. generación, costo estimado) sin llamar a ningún proveedor, en ningún escenario de flags |
| Validación de archivo antes de usar/subir | `visual-asset-validation.ts` — magic bytes, MIME, dimensiones, tamaño — nunca confía en que "no lanzó error" ya implica "es una imagen real" |

## Trazabilidad (`generation_costs`, migración 0012 — no aplicada)

Además de `image_provider`/`image_generation_count`/`image_cost_usd` (migración 0010, tampoco aplicada), la migración 0012 añade:

- `image_requested_count` — escenas que la política decidió **intentar** generar (haya funcionado o no).
- `image_reused_count` — de esas, cuántas se resolvieron por idempotencia (archivo ya existente).
- `image_dry_run` — reservada para distinguir una ejecución dry-run de una real (el script de dry-run no toca la base de datos; esta columna documenta la distinción para cuando exista un flujo que sí la use).
- `image_model` / `image_size` — configuración usada (nunca credenciales).

`generate-video.ts` ya llama a `recordVideoGeneration()` con estos campos poblados cuando hubo al menos una escena candidata a generación — protegido por el mismo `.catch()` no bloqueante que ya usa el resto de la instrumentación (si la migración no está aplicada en producción, el registro de costo simplemente falla en silencio sin tumbar el video, igual que ya pasa con `image_provider` desde la fase anterior).

## Cómo activar generación real en el futuro

```
VISUAL_DIRECTOR_ENABLED=true
OPENAI_IMAGE_GENERATION_ENABLED=true
IMAGE_PROVIDER=openai
OPENAI_API_KEY=...
MAX_GENERATED_IMAGES_PER_VIDEO=3
MAX_VISUAL_COST_USD=1
```

Las tres primeras variables son intencionalmente independientes (ver política arriba) — activar solo una o dos no produce ninguna llamada real. Con las cinco activas, el pipeline generará como máximo `MAX_GENERATED_IMAGES_PER_VIDEO` imágenes por video, solo para escenas que el Visual Director real (Claude, no el modo simulado) clasificó como conceptuales/simbólicas con confianza ≥0.6.

**Nota importante confirmada en esta fase:** el modo storyboard **simulado** (sin `ANTHROPIC_API_KEY`, `src/lib/video/storyboard/simulate.ts`) nunca marca ninguna escena como `generated_image` — siempre usa `stock_video`. Esto significa que activar las flags de arriba SIN también tener `ANTHROPIC_API_KEY` configurada (para el Visual Director real) nunca produce una llamada real a OpenAI — otra capa de protección, no solo documentación.

## Rollback

Ninguna de las variables nuevas afecta el pipeline si no se configuran — desactivarlas (`OPENAI_IMAGE_GENERATION_ENABLED=false`, ya el default) revierte al 100% del comportamiento anterior sin necesidad de revertir código. La migración 0012 se revierte con el bloque `drop column if exists` documentado en su propio archivo — no borra ninguna imagen ya subida a Storage.

## Qué está validado vs. pendiente

**Validado en esta fase (todo con mocks/fixtures, cero llamadas reales):**
- Política de decisión (`decideResourceStrategy`): 15 pruebas cubriendo cada condición de la lista de arriba.
- Resolución con I/O simulado (`resolveGeneratedImageForScene`): reutilización idempotente, generación+subida nueva, archivo inválido rechazado, error del proveedor propagado sin fallback pagado — 6 pruebas con Supabase y `ImageProvider` mockeados.
- Validación de archivo (`visual-asset-validation.ts`): 7 pruebas (PNG/SVG/MIME/dimensiones/tamaño).
- Wiring estructural en `generate-video.ts`: confirmado por prueba automatizada (try/catch, fallback alcanzable, sin mención de otros proveedores de pago en el catch).
- Pipeline completo con fixtures (`npm run test:pipeline`, flags apagadas — el default): sin regresión, video generado igual que antes de esta fase.

**Pendiente / limitación conocida, documentada:**
- No se ejecutó un render completo end-to-end con la rama de GENERACIÓN activa (`VISUAL_DIRECTOR_ENABLED=true` + `OPENAI_IMAGE_GENERATION_ENABLED=true` + Visual Director REAL, no simulado) — eso requeriría una llamada real a Claude para clasificar escenas como `generated_image`, fuera del alcance autorizado de "cero llamadas pagadas" de esta fase. La cobertura de esa rama es a nivel unitario (planner + resolver), no de integración completa.
- `video_requests.visual_plan_json` (persistir el plan completo por solicitud) no se implementó — se decidió no agregar la columna todavía porque no se iba a cablear su escritura en esta fase (mismo criterio que `storyboard_json`, que tampoco se escribe hasta que la migración 0010 esté aplicada). El plan completo SÍ queda en los logs (`[atomivid:visual-plan]`) por solicitud.
- Sin un renderizador propio de "motion graphics" — el `resourceType: "motion_graphic"` del storyboard cae a stock, no a un tratamiento visual distinto.
