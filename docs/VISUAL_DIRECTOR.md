# Visual Director — capa creativa semántica (imagen/video/música generados)

Estado: **implementado y probado, apagado por defecto**. El pipeline actual (guion → voz → footage Pexels/Pixabay → música curada → Remotion) sigue funcionando exactamente igual sin ninguna variable de este documento configurada.

## Qué es

Una capa intermedia que convierte el guion COMPLETO (no frases sueltas) en un **storyboard** validado por schema (`src/lib/video/storyboard/types.ts`), con intención narrativa, emoción, prompts detallados, consultas alternativas de stock, tipo de recurso recomendado y una estrategia de fallback ordenada por escena. Ver `src/lib/video/storyboard/`.

**Estado real de la integración**: el storyboard se genera (o simula) y se loguea de forma diagnóstica cuando `VISUAL_DIRECTOR_ENABLED=true`, pero **todavía no reemplaza** la lógica de selección de `footage-select.ts` — esa es la siguiente iteración. Hoy sirve para: previsualizar la decisión creativa (modo dry-run), y como base ya construida y probada para conectar los proveedores de imagen/video/música generados.

## Cómo previsualizar sin gastar nada (dry-run)

```bash
npx tsx scripts/dry-run-storyboard.ts
```

Imprime el storyboard completo, el prompt musical y una estimación de costo, usando el guion **fixture** (gratis) y el storyboard **simulado** (gratis) por defecto. Nunca llama a un proveedor de pago salvo que configures explícitamente `DRY_RUN_SCRIPT_PROVIDER=anthropic` (eso sí gasta en la generación del guion, nada más).

Variables opcionales: `DRY_RUN_TOPIC`, `DRY_RUN_STYLE`, `DRY_RUN_LANGUAGE`, `DRY_RUN_DURATION_SECONDS`.

## Feature flags (`src/lib/video/feature-flags.ts`)

| Variable | Default | Efecto |
|---|---|---|
| `VISUAL_DIRECTOR_ENABLED` | `false` | Enciende la llamada extra a Claude para generar el storyboard real (tiene costo incremental — ver abajo). |
| `IMAGE_PROVIDER` | `fixture` | `openai` para intentar OpenAI Images — sin `OPENAI_API_KEY` cae a fixture. |
| `VIDEO_PROVIDER` | `fixture` | `runway` para intentar Runway — requiere TAMBIÉN `PREMIUM_CLIPS_ENABLED=true` y `RUNWAY_API_KEY`. |
| `MUSIC_PROVIDER` | (el existente) | `beatoven` para intentar Beatoven Maestro — sin `BEATOVEN_API_KEY` cae al proveedor curado. |
| `PREMIUM_CLIPS_ENABLED` | `false` | Interruptor de gasto explícito para Runway — sin esto, Runway nunca se llama aunque `VIDEO_PROVIDER=runway` y la clave esté presente. |
| `MAX_PREMIUM_CLIPS` | `1` | Tope de clips Runway por video. |
| `MAX_PREMIUM_CLIP_SECONDS` | `5` | Runway solo admite 5 o 10s (fuente secundaria, no verificada). |
| `MAX_VISUAL_COST_USD` | `1` | Tope de gasto en imágenes generadas por video. |
| `MAX_PREMIUM_VIDEO_COST_USD` | `1` | Tope de gasto en clips Runway por video. |
| `MAX_MUSIC_COST_USD` | `1` | Tope de gasto en música Beatoven por video. |
| `VISUAL_QA_ENABLED` | `false` | Enciende los chequeos deterministas de `src/lib/video/visual-qa.ts` (dimensiones/tamaño/aspecto — NO evaluación semántica real, eso requiere un modelo multimodal que hoy no está configurado). |

## Cómo activar cada proveedor

### Claude (Visual Director / storyboard)
Ya usa `ANTHROPIC_API_KEY` (el mismo de la generación de guion). Solo hace falta `VISUAL_DIRECTOR_ENABLED=true`. Costo incremental: una llamada extra a Claude por video (ver `src/lib/video/storyboard/visual-director.ts`, modelo configurable en `ANTHROPIC_VISUAL_DIRECTOR_MODEL`).

### OpenAI (imágenes) — `src/lib/providers/image/openai.ts`
1. `IMAGE_PROVIDER=openai`
2. `OPENAI_API_KEY=...`
3. Opcional: `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_SIZE`, `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_ESTIMATED_COST_USD`.

**Importante**: el modelo (`gpt-image-2`), tamaño y precio por defecto vienen de fuentes secundarias (agregadores de precios, sep 2026) — este entorno de desarrollo tiene bloqueado el acceso a `platform.openai.com`, así que no se pudo verificar contra la documentación oficial primaria. Confirma contra <https://platform.openai.com/docs/guides/image-generation> antes de activar con una clave real.

### Runway (clips premium) — `src/lib/providers/video-gen/runway.ts`
1. `VIDEO_PROVIDER=runway`
2. `PREMIUM_CLIPS_ENABLED=true`
3. `RUNWAY_API_KEY=...`
4. Opcional: `RUNWAY_API_BASE`, `RUNWAY_MODEL`, `RUNWAY_COST_USD_PER_SECOND`.

**Importante**: mismo caveat que OpenAI — `docs.dev.runwayml.com` está bloqueado en este entorno. El endpoint, el modelo (`gen4_turbo`), el precio ($0.05/s) y las duraciones (5/10s) vienen de fuentes secundarias. Confirma contra <https://docs.dev.runwayml.com/> antes de activar con una clave real.

### Beatoven Maestro (música) — `src/lib/providers/music/beatoven.ts`
1. `MUSIC_PROVIDER=beatoven`
2. `BEATOVEN_API_KEY=...`
3. Opcional: `BEATOVEN_API_BASE`, `BEATOVEN_ESTIMATED_COST_USD` (0 por defecto — sin precio público confirmado).

**Importante**: `www.beatoven.ai` está bloqueado en este entorno. Se confirmó por búsqueda que Maestro existe y se anuncia como apto para uso comercial, pero el endpoint/schema exacto de la API es un andamiaje plausible, no verificado. La música curada (Pixabay/Mixkit) sigue siendo el fallback automático si Beatoven falla o no está configurado — nunca bloquea el render.

## Migración pendiente

`supabase/migrations/0010_visual_director.sql` añade columnas para guardar el storyboard (`video_requests.storyboard_json`/`storyboard_source`) y el desglose de costo de imagen/video premium (`generation_costs.image_cost_usd`/`premium_video_cost_usd`/etc.) — **no aplicada automáticamente**, sigue el mismo procedimiento que las migraciones anteriores (pegar en el SQL Editor de Supabase).

## Próximo paso (no incluido en esta iteración)

Conectar el storyboard con `footage-select.ts` para que decida de verdad qué recurso pedir por escena (hoy solo se genera y se loguea). Requiere: (1) confirmar los tres contratos de API contra documentación oficial primaria, (2) una prueba controlada de un solo video real con presupuesto acotado, autorizada explícitamente.
