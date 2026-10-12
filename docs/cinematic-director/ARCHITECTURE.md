# Director Cinematográfico Inteligente V1 — arquitectura y contrato

Estado: **MVP en modo propuesta, apagado por defecto y no conectado a producción.** Solicitud T-20261012-0142-chatgpt-18.

Este módulo no genera medios, no llama a ningún LLM y no gasta. Por contrato, todo plan lleva `executable: false` y `paidCalls: 0`.

## 1. Inventario del sistema existente (contrastado con el código, base a4d3614)

| Área | Pieza existente | Estado |
|---|---|---|
| Planificación de shots | `long-form/shots.ts` (`shotsForSpan`, holds de 3–8 s), `production-plan.ts` (`planShotsFromScript`, `allocateShotTypes`), `types.ts` (`Shot`, `NarrativeBeat`) | **Conectado** (worker `run-job.ts` → `produce.ts`) |
| Storyboard manual | `storyboard-shots.ts`, `storyboard-loader.ts` | Existe; solo lo usa el piloto de Göbekli |
| Beats de Reel | `video/scene-beats.ts` | **Conectado** (Reels, `generate-video.ts`) |
| Dirección de montaje | `montage-direction.ts`: corte duro, disolvencia al cambiar de era, cortes ajustados al habla | **Conectado** desde el plan v3 |
| Director cinematográfico existente | `cinematic-director.ts`: tiers HERO/PREMIUM/STANDARD, QA y bloqueos de entrega | Cableado, pero **activo solo con plan v4+**; el producto usa v3 |
| Impacto / secuencias | `impact-direction.ts`, `sequence-*.ts` | Solo v5/v6, con allowlist |
| Visual Director de Reels | `video/storyboard/visual-director.ts` | Detrás de `VISUAL_DIRECTOR_ENABLED=false` |
| Selección de recursos | `shot-executor.ts`, `stock-selection.ts`, `verified-assets.ts`, curación desde admin | **Conectado** |
| Duplicados | `asset-identity.ts`: `dhashImage`, `hammingHex`, umbral 6, sha256, URL canónica | **Conectado** desde v3. Este módulo lo **reutiliza** |
| Elegibilidad IA y gasto | `ai-video-eligibility.ts`, `ai-video-cost-guard.ts`, `spend-cap.ts`, `production-budget.ts`, `paid-calls/gate.ts` | **Conectado** |
| Procedencia / rótulos | `SceneProvenance` (`remotion/long-form-card-fit.ts`), `durable-shot-assets.ts`, render en `LongFormDoc.tsx` | **Conectado**. Este módulo usa el mismo vocabulario |
| Validación | Hay Zod en guion, editorial y storyboard de Reel. **No hay Zod** para `ProductionPlan` ni para las props de Remotion | Laguna |
| Biblia visual | `content/long-form/atomivid-long-form-visual-bible-v1.md`: geografía y cronología deterministas, nada de IA sobre restos humanos, etiquetado, licencias en NEEDS_REVIEW por defecto | Este módulo aplica estas reglas |
| Contratos de render | **Dos rutas distintas**: Remotion (`VerticalReel` para Reels, `LongFormDoc` para largos) y el editor Python con `montaje.json` (podcast) | No se asume que sean equivalentes |

**Lagunas que cubre V1:**
- un plan por shot con intención explícita y ancla exacta al texto;
- recetas versionadas y reutilizables;
- una puerta determinista que no depende del plan v4;
- métricas de comparación honestas.

**Qué no hace:** no crea otro editor, orquestador, ledger ni base de datos.

## 2. Flujo

```mermaid
flowchart LR
  G[Guion + tiempos por segmento] --> D[Director V1<br/>modo propuesta<br/>reglas + recetas]
  I[Inventario: hash, licencia,<br/>procedencia, movimiento] --> D
  R[(recipes.v1.json<br/>versionado)] --> D
  D --> P[director-plan@1<br/>executable=false, paidCalls=0]
  P --> A{auditPlan<br/>puerta determinista}
  A -- issues --> H[Revisión humana /<br/>override manual]
  A -- ok --> X[Pipeline existente<br/>sin cambios: production-plan →<br/>shot-executor con guardas de gasto]
  X --> M[Montaje: Remotion LongFormDoc /<br/>VerticalReel · editor Python]
  M --> Z[Render]
```

Hoy el pipeline existente **no lee** el plan. La flecha hacia X marca el punto de integración futuro, que quedaría detrás de `CINEMATIC_DIRECTOR_V2_ENABLED` (apagado) y de las guardas de gasto que ya existen.

## 3. Contrato (Zod, `src/lib/video/director/contract.ts`)

### `director-input@1`

| Campo | Contenido |
|---|---|
| Género | `misterio`, `documental` o `reel` |
| Aspecto y duración total | Formato del vídeo y segundos totales |
| Segmentos | Texto, beat, evidencia auténtica disponible y segmento bloqueado de avatar |
| Inventario | Tipo; procedencia (`archival_documentary`, `stock_illustrative`, `ai_recreation`, `data_graphic`); movimiento real o imagen fija; sha256; dHash; licencia; etiquetas |
| Restricciones | 3–8 s por plano, rótulos de 3 s como máximo, 2 líneas de subtítulos |
| Presupuesto | Restante, costes unitarios y `allowAiVideo=false` por defecto |
| Continuidad | Época y vestuario |

### `director-plan@1`

Cada shot del plan incluye:
- **Ancla exacta:** subcadena literal del texto del segmento.
- **Receta e intención**, y el tipo de plano.
- **Movimiento con `realMotion`:** un zoom sobre una foto nunca cuenta como movimiento real.
- **Recurso:** el elegido y sus alternativas, o `needs_new` con el motivo y el coste máximo estimado.
- **Etiqueta:** `recreacion_ia` o `ilustrativa`.
- **Incertidumbres** declaradas.

El contrato fija estos literales: `mode: "proposal"`, `executable: false`, `paidCalls: 0`, y `qualityNote` «estimado/no validado».

### Catálogo `atomivid/cinematic-recipes@1`

- Los ids son únicos.
- Una receta `authentic_only` nunca puede llevar `recreacion_ia`.
- Está prohibido el sufijo universal «8K anamorphic» como instrucción positiva.

### Ejemplo real generado por `proposePlan`

```json
{
  "version": "director-plan@1",
  "mode": "proposal",
  "executable": false,
  "paidCalls": 0,
  "genre": "misterio",
  "catalogVersion": "1.0.0",
  "totalSeconds": 12,
  "shots": [
    {
      "id": "s1-s1",
      "segmentId": "s1",
      "start": 0,
      "end": 6,
      "anchorText": "Era de noche en la carretera del bosque cuando",
      "recipeId": "mys-night-road-approach",
      "recipeVersion": 1,
      "intent": "instalar inquietud y lugar antes del evento",
      "shotType": "plano general",
      "movement": {
        "kind": "real_motion",
        "realMotion": true
      },
      "asset": {
        "status": "chosen",
        "assetId": "road",
        "provenance": "stock_illustrative",
        "alternatives": [],
        "label": "ilustrativa"
      },
      "uncertainty": []
    },
    {
      "id": "s1-s2",
      "segmentId": "s1",
      "start": 6,
      "end": 12,
      "anchorText": "los testigos vieron una luz detrás de los árboles.",
      "recipeId": "mys-tree-line-glow",
      "recipeVersion": 1,
      "intent": "anticipar sin mostrar el objeto",
      "shotType": "plano general fijo",
      "movement": {
        "kind": "static",
        "realMotion": false
      },
      "asset": {
        "status": "needs_new",
        "provenance": "ai_recreation",
        "alternatives": [],
        "label": "recreacion_ia"
      },
      "newMaterial": {
        "reason": "sin recurso en el inventario para «los testigos vieron una luz detrás de los árboles.»",
        "kind": "ai_image",
        "estimatedMaxUsd": 0.04
      },
      "uncertainty": []
    }
  ],
  "estimatedMaxUsd": 0.04,
  "qualityNote": "semántica y calidad visual: estimado/no validado sin anotación humana"
}
```

## 4. Separación entre lo generativo y lo determinista

**Generativo (solo se describe, nunca se ejecuta aquí):** intención, encuadre, variedad y prompts. V1 los toma de la receta que eligen las reglas. Un LLM podría proponerlos en el futuro, **solo** con permiso de presupuesto y con las guardas de gasto.

**Determinista (`audit.ts`)** comprueba:
- **Línea de tiempo:** suma de duraciones, cobertura del guion, contigüidad, límites por plano y anclas.
- **Duplicados:** por id, sha256 o dHash ≤ 6, reutilizando `asset-identity.ts`.
- **Movimiento falso** y **rótulos grandes permanentes** (más de 3 s).
- **Avatar y continuidad:** segmentos de avatar bloqueados; continuidad de época y vestuario.
- **Evidencia:** etiquetado de las recreaciones; la evidencia auténtica no lleva look de recreación; recetas `authentic_only` sin evidencia.
- **Presupuesto.**

Si no hay evidencia de un clip, se marca la incertidumbre en vez de inventar.

## 5. Biblioteca de recetas

`content/cinematic-director/recipes.v1.json` contiene 30 recetas originales:
- 12 de misterio/OVNI;
- 10 de documental/historia;
- 8 de Reel/anuncio vertical.

Cada género tiene sus presets y sus antimotivos. La política de evidencia impide aplicar el mismo look a la evidencia auténtica y a la recreación IA.

### 1. `mys-night-road-approach`

**Propósito:** abrir un caso de misterio situando el lugar y la hora antes del evento.

**Regla clave:** exige movimiento real. Si solo hay una foto, el director la degrada a zoom y lo declara.

```json
{
  "id": "mys-night-road-approach",
  "version": 1,
  "genre": "misterio",
  "name": "Carretera nocturna, aproximación",
  "use_when": [
    "el relato sitúa a testigos conduciendo de noche",
    "apertura de un caso"
  ],
  "avoid_when": [
    "la evidencia es una foto auténtica del lugar"
  ],
  "duration_s": {
    "min": 4,
    "typical": 6,
    "max": 8
  },
  "intent": "instalar inquietud y lugar antes del evento",
  "shot": {
    "type": "plano general"
  },
  "composition": "horizonte bajo, carretera en fuga hacia el tercio superior",
  "movement": {
    "kind": "real_motion",
    "note": "clip con movimiento real (no un zoom sobre imagen fija)"
  },
  "lighting": "faros como única fuente; cielo casi negro",
  "continuity": "mismo vehículo y hora en todo el bloque",
  "transitions": {
    "in": [
      "fade_from_black",
      "cut"
    ],
    "out": [
      "cut",
      "dip_to_black"
    ]
  },
  "sfx": "motor lejano, grillos, sin música al inicio",
  "placeholders": [
    "{lugar}",
    "{ano}",
    "{vehiculo}"
  ],
  "negatives": [
    "rótulos permanentes",
    "luces de neón",
    "drones",
    "8K anamorphic como sufijo"
  ],
  "evidence_policy": "recreation_ok",
  "label": "recreacion_ia",
  "example": "Pickup de los setenta avanza por una pista forestal; solo los faros recortan pinos.",
  "lens": "24-35 mm equivalente"
}
```

### 2. `mys-archive-document-insert`

**Propósito:** anclar el relato en evidencia verificable.

**Regla clave:** es `authentic_only`. Sin documento real en el inventario no se genera nada (se marca la incertidumbre), y nunca lleva el look de recreación.

```json
{
  "id": "mys-archive-document-insert",
  "version": 1,
  "genre": "misterio",
  "name": "Inserto de documento de archivo",
  "use_when": [
    "se cita un informe, periódico o expediente real disponible"
  ],
  "avoid_when": [
    "no hay documento auténtico con procedencia"
  ],
  "duration_s": {
    "min": 3,
    "typical": 5,
    "max": 7
  },
  "intent": "anclar el relato en evidencia verificable",
  "shot": {
    "type": "inserto"
  },
  "composition": "documento centrado, margen para subtítulos abajo",
  "movement": {
    "kind": "push_in_still",
    "note": "acercamiento lento sobre imagen fija; nunca se presenta como clip en movimiento"
  },
  "lighting": "neutra, sin tinte; textura del papel visible",
  "continuity": "citar fecha y fuente reales",
  "transitions": {
    "in": [
      "cut",
      "dissolve_short"
    ],
    "out": [
      "cut"
    ]
  },
  "sfx": "papel, máquina de escribir muy suave",
  "placeholders": [
    "{documento_id}",
    "{fuente}",
    "{fecha}"
  ],
  "negatives": [
    "inventar titulares",
    "añadir sellos falsos",
    "aplicar look de recreación"
  ],
  "evidence_policy": "authentic_only",
  "label": null,
  "example": "Recorte de prensa escaneado, zoom lento hacia el titular citado por la narración."
}
```

### 3. `doc-map-route`

**Propósito:** mostrar la geografía, que según la biblia visual siempre es determinista.

**Regla clave:** solo se habilita si hay un gráfico o mapa determinista planificado para ese segmento.

```json
{
  "id": "doc-map-route",
  "version": 1,
  "genre": "documental",
  "name": "Mapa con ruta",
  "use_when": [
    "desplazamientos, rutas comerciales o expansión"
  ],
  "avoid_when": [
    "no hay datos geográficos concretos"
  ],
  "duration_s": {
    "min": 4,
    "typical": 6,
    "max": 9
  },
  "intent": "claridad espacial",
  "shot": {
    "type": "gráfico"
  },
  "composition": "mapa limpio, ruta animada",
  "movement": {
    "kind": "real_motion",
    "note": "clip con movimiento real (no un zoom sobre imagen fija)"
  },
  "lighting": "neutra",
  "continuity": "mismo estilo de mapa en todo el vídeo",
  "transitions": {
    "in": [
      "cut"
    ],
    "out": [
      "cut"
    ]
  },
  "sfx": "trazo suave",
  "placeholders": [
    "{origen}",
    "{destino}",
    "{fecha}"
  ],
  "negatives": [
    "fronteras modernas en mapas antiguos sin aviso"
  ],
  "evidence_policy": "authentic_only",
  "label": null,
  "example": "Línea que avanza de Mesopotamia a Anatolia sobre relieve sobrio."
}
```

### 4. `doc-reconstruction-wide`

**Propósito:** imaginar el pasado con base académica.

**Regla clave:** es `recreation_ok` y lleva obligatoriamente la etiqueta `recreacion_ia`. Nunca se aplica sobre evidencia auténtica.

```json
{
  "id": "doc-reconstruction-wide",
  "version": 1,
  "genre": "documental",
  "name": "Reconstrucción amplia",
  "use_when": [
    "explicar cómo era un lugar en su época"
  ],
  "avoid_when": [
    "no hay base académica citada"
  ],
  "duration_s": {
    "min": 5,
    "typical": 7,
    "max": 9
  },
  "intent": "imaginar el pasado con base",
  "shot": {
    "type": "plano general"
  },
  "composition": "personas pequeñas, arquitectura dominante",
  "movement": {
    "kind": "real_motion",
    "note": "clip con movimiento real (no un zoom sobre imagen fija)"
  },
  "lighting": "luz natural plausible para la época",
  "continuity": "coherencia de vestimenta y materiales",
  "transitions": {
    "in": [
      "dissolve_short"
    ],
    "out": [
      "dissolve_short",
      "cut"
    ]
  },
  "sfx": "ambiente de época discreto",
  "placeholders": [
    "{epoca}",
    "{lugar}"
  ],
  "negatives": [
    "anacronismos",
    "multitudes de película épica"
  ],
  "evidence_policy": "recreation_ok",
  "label": "recreacion_ia",
  "example": "Círculo de pilares de piedra con figuras trabajando al atardecer."
}
```

### 5. `reel-ui-screen-demo`

**Propósito:** demostrar el producto real en Reels.

**Regla clave:** es `authentic_only` y lleva el rótulo «Demostración ilustrativa» si no es un flujo real. Prohíbe inventar funciones o contadores.

```json
{
  "id": "reel-ui-screen-demo",
  "version": 1,
  "genre": "reel",
  "name": "Demostración de interfaz real",
  "use_when": [
    "mostrar la app"
  ],
  "avoid_when": [
    "no hay captura real de la interfaz"
  ],
  "duration_s": {
    "min": 3,
    "typical": 4,
    "max": 6
  },
  "intent": "probar con producto real",
  "shot": {
    "type": "plano de pantalla"
  },
  "composition": "pantalla centrada en marco de móvil, margen para subtítulos",
  "movement": {
    "kind": "real_motion",
    "note": "clip con movimiento real (no un zoom sobre imagen fija)"
  },
  "lighting": "la de la UI",
  "continuity": "capturas reales, rotular «Demostración ilustrativa» si no es un flujo real",
  "transitions": {
    "in": [
      "cut",
      "zoom_cut"
    ],
    "out": [
      "cut"
    ]
  },
  "sfx": "clics suaves",
  "placeholders": [
    "{pantalla}"
  ],
  "negatives": [
    "inventar funciones",
    "contadores falsos"
  ],
  "evidence_policy": "authentic_only",
  "label": "ilustrativa",
  "example": "Grabación real del formulario de idea y la revisión del guion."
}
```

## 6. Comparación reproducible (sin proveedores)

Comando: `npx tsx scripts/cinematic-director-compare.ts`. Se ejecuta sobre tres storyboards aprobados del repositorio (Göbekli Tepe), en solo lectura y sin datos privados. Usa los costes unitarios de `getGenerativeUnitCosts()`. El resultado está en `docs/cinematic-director/COMPARISON.json`.

| Fixture | Programa | Storyboard actual: shots | Shots de más de 8 s | Rótulos de texto de más de 3 s | Propuesta: shots | Cobertura | Duplicados | Variedad | Máx. misma receta seguida | Material nuevo | Coste máx. estimado (USD) | Issues |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gobekli-storyboard-003 + script-003 | 660 s | 45 (planeación) | 45 | 17 | 90 | 100% | 0 | 0.7 | 1 | 62 | 3.1 | BUDGET_EXCEEDED |
| gobekli-storyboard-002-hybrid + script-002 | 502 s | 44 (planeación) | 39 | 15 | 68 | 100% | 0 | 0.6 | 1 | 46 | 2.3 | BUDGET_EXCEEDED |
| gobekli-storyboard-001 + script-002 | 502 s | 44 (planeación) | 39 | 15 | 68 | 100% | 0 | 0.6 | 1 | 39 | 1.95 | BUDGET_EXCEEDED |

Cómo leer esta tabla:
- **Los conteos no son comparables 1:1.** Los shots del storyboard son unidades de planeación que el pipeline subdivide después (`shotsForSpan`).
- **Objetivos alcanzados:** 100 % de contrato, duración y cobertura; 0 duplicados; 0 llamadas y 0 cargos.
- **`BUDGET_EXCEEDED` es el resultado correcto.** La comparación no autoriza presupuesto (0 USD), y el inventario derivado del storyboard tiene menos recursos que planos de 8 s o menos sin repetir. El director **no reutiliza** recursos para rellenar: declara lo que falta como material nuevo.
- **Variedad, alineación frase-imagen y calidad visual son estimaciones** sin validar, porque no hay anotación humana. Que el JSON valide no demuestra una mejor calidad visual.

## 7. Impacto esperado (estimaciones, no facturación)

- **Latencia del modo propuesta:** milisegundos (O(segmentos × recetas)); no usa red.
- **Coste con `allowAiVideo=false`:** con los costes unitarios del plan de producción (imagen IA USD 0,05; clip Veo USD 0,96), las tres comparaciones estiman entre USD 1,95 y 3,10 de imágenes nuevas para 8–11 minutos.
- **Escalado a 15–30 minutos:** unos USD 4–9, solo en imágenes, si el inventario es tan escaso como el del storyboard.
- **Con vídeo IA permitido:** un orden de magnitud más; en el peor caso, unos USD 80–160 para 15–30 minutos.
- **Topes reales:** los siguen imponiendo `spend-cap.ts`, `production-budget.ts` y `paid-calls/gate.ts`.

## 8. Integración controlada, override y rollback

- **Flag apagado:** `CINEMATIC_DIRECTOR_V2_ENABLED`, con las mismas reglas que `feature-flags.ts`. Ninguna ruta, worker ni script de producción importa el módulo.
- **Override manual:** cualquier shot del plan se puede editar; `auditPlan` lo vuelve a validar (contrato y reglas) antes de usarlo.
- **Rollback:** basta con quitar el flag o no leer el plan. El SaaS sigue operando con el pipeline v3 actual, sin cambios.
- **Siguiente fase (no autorizada aquí):**
  - un adaptador que traduzca los shots aprobados a `AllocatedShot` (largos) o a segmentos de `montaje.json` (podcast);
  - pruebas con anotación humana;
  - cualquier LLM o generación, solo con permiso de presupuesto.
