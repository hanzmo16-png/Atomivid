# Director Cinematográfico Inteligente V1 — arquitectura y contrato

Estado: **MVP en modo propuesta, apagado por defecto y no conectado a producción.** Solicitud T-20261012-0142-chatgpt-18; correcciones T-20261012-0318-chatgpt-19, T-20261012-0555-chatgpt-20 y T-20261012-0712-chatgpt-21.

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
  R[(recipes.v2.json<br/>versionado)] --> D
  D --> P[director-plan@2<br/>executable=false, paidCalls=0]
  P --> A{auditPlan<br/>puerta determinista}
  A -- issues --> H[Revisión humana /<br/>override manual]
  A -- ok --> X[Pipeline existente<br/>sin cambios: production-plan →<br/>shot-executor con guardas de gasto]
  X --> M[Montaje: Remotion LongFormDoc /<br/>VerticalReel · editor Python]
  M --> Z[Render]
```

Hoy el pipeline existente **no lee** el plan. La flecha hacia X marca el punto de integración futuro, que quedaría detrás de `CINEMATIC_DIRECTOR_V2_ENABLED` (apagado) y de las guardas de gasto que ya existen.

## 3. Contrato (Zod, `src/lib/video/director/contract.ts`)

### `director-input@2`

| Campo | Contenido |
|---|---|
| Género | `misterio`, `documental` o `reel` |
| Aspecto y duración total | Formato del vídeo y segundos totales |
| Segmentos | Texto, beat, evidencia auténtica disponible y segmento bloqueado de avatar |
| Inventario | Tipo; procedencia (`archival_documentary`, `stock_illustrative`, `ai_recreation`, `data_graphic`); movimiento real o imagen fija; sha256; dHash; licencia; etiquetas |
| Restricciones | 3–8 s por plano, rótulos de 3 s como máximo, 2 líneas de subtítulos |
| Presupuesto | Restante, costes unitarios y `allowAiVideo=false` por defecto |
| Continuidad | Época y vestuario |
| Afirmaciones del guion (corrección 2) | Por segmento, con su nivel de apoyo (`sourced`, `inference`, `unverified`) |
| Marcas de palabra (corrección 2) | Opcionales; si existen se usan para cortar, si no la alineación se declara estimada |
| Metadatos editoriales del recurso (corrección 2) | Tipo visual, temas, intención visual, sensibilidad, clase de la biblia y ventana planificada en el storyboard. Si faltan, nada se presume seguro |

### `director-plan@2`

Cada shot del plan incluye:
- **Ancla exacta:** subcadena literal del texto del segmento.
- **Receta e intención**, y el tipo de plano.
- **Movimiento con `realMotion`:** un zoom sobre una foto nunca cuenta como movimiento real.
- **Recurso:** el elegido y sus alternativas, o `needs_new` con el motivo y el coste máximo estimado.
- **Etiqueta:** `recreacion_ia` o `ilustrativa`.
- **Incertidumbres** declaradas.
- **Corrección 2 — registro de decisión emitido por el propio módulo** (no se reconstruye después):
  - `unit`: tipo de corte (oración, cláusula o palabra), su motivo y si el tiempo es estimado o viene de marcas de palabra;
  - `policy`: clase documental de la frase (`documentary-policy@1`), fuentes, señales, si es una afirmación no confirmada y si requiere revisión;
  - `visualTheme`: qué se ve, en palabras (no es un prompt);
  - `decision`: estado (`proposed`, `weak` o `pending`), temas de la frase, bases del recurso y de la receta, fuentes y motivo del pendiente;
  - `suggestions`: transición, composición y sonido del catálogo como sugerencias revisables (sin assets sonoros).

El contrato fija estos literales: `mode: "proposal"`, `executable: false`, `paidCalls: 0`, y `qualityNote` «estimado/no validado».

### Catálogo `atomivid/cinematic-recipes@2`

- Los ids son únicos.
- Una receta `authentic_only` nunca puede llevar `recreacion_ia`.
- Está prohibido el sufijo universal «8K anamorphic» como instrucción positiva.
- Corrección 2: cada receta lleva una regla `select` operable (tipos visuales aceptados, temas o palabras requeridos, temas excluidos, procedencias permitidas, qué hacer con una imagen fija, posición y si es atmósfera neutral). `use_when` y `avoid_when` quedan como descripción humana; la decisión automática usa solo `select`.

### Ejemplo real generado por `proposePlan`

```json
{
  "version": "director-plan@2",
  "mode": "proposal",
  "executable": false,
  "paidCalls": 0,
  "genre": "misterio",
  "catalogVersion": "2.0.0",
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
        "label": "ilustrativa",
        "continuation": false
      },
      "uncertainty": [
        "alineación temporal estimada (sin marcas de palabra): no validada contra la locución"
      ],
      "unit": {
        "boundary": "word",
        "timing": "estimated_proportional",
        "cutReason": "oración más larga que 8 s: corte entre palabras (revisar)"
      },
      "policy": {
        "version": "documentary-policy@1",
        "class": "atmosphere",
        "sources": [
          "default"
        ],
        "signals": [],
        "status": "ok",
        "unconfirmed": false
      },
      "visualTheme": "recurso road",
      "decision": {
        "status": "proposed",
        "unitTopics": [],
        "assetBasis": [
          "palabras compartidas: carretera, noche",
          "política atmosphere: atmósfera: sin afirmación factual específica"
        ],
        "recipeBasis": [
          "regla de la receta acepta el tipo visual «concept»",
          "coincide: palabra:carretera, palabra:noche",
          "alternativas compatibles: mys-night-sky-stars, mys-tree-line-glow, mys-empty-site-today"
        ],
        "sources": [
          "lexicon",
          "catalog_rule"
        ],
        "neutral": false
      },
      "suggestions": {
        "transitionIn": "fade_from_black",
        "transitionOut": "cut",
        "composition": "horizonte bajo, carretera en fuga hacia el tercio superior",
        "sound": "motor lejano, grillos, sin música al inicio (sugerencia; no hay asset sonoro)",
        "status": "sugerencia_revisable"
      }
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
        "label": "recreacion_ia",
        "continuation": false
      },
      "newMaterial": {
        "reason": "sin recurso compatible en el inventario para «los testigos vieron una luz detrás de los árboles.»",
        "kind": "ai_image",
        "estimatedMaxUsd": 0.04
      },
      "uncertainty": [
        "alineación temporal estimada (sin marcas de palabra): no validada contra la locución"
      ],
      "unit": {
        "boundary": "sentence",
        "timing": "estimated_proportional",
        "cutReason": "fin de oración"
      },
      "policy": {
        "version": "documentary-policy@1",
        "class": "atmosphere",
        "sources": [
          "default"
        ],
        "signals": [],
        "status": "ok",
        "unconfirmed": false
      },
      "visualTheme": "recreación genérica (concept) de: atmósfera",
      "decision": {
        "status": "proposed",
        "unitTopics": [],
        "assetBasis": [
          "sin recurso compatible en el inventario"
        ],
        "recipeBasis": [
          "regla de la receta acepta el tipo visual «concept»",
          "coincide: palabra:luz, palabra:arboles",
          "alternativas compatibles: mys-witness-pov-windshield, mys-closing-unresolved, mys-empty-site-today"
        ],
        "sources": [
          "lexicon",
          "catalog_rule"
        ],
        "neutral": false
      },
      "suggestions": {
        "transitionIn": "cut",
        "transitionOut": "cut",
        "composition": "árboles en silueta ocupando el tercio inferior; resplandor fuera de cuadro",
        "sound": "zumbido grave muy bajo (sugerencia; no hay asset sonoro)",
        "status": "sugerencia_revisable"
      }
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

`content/cinematic-director/recipes.v2.json` (catálogo 2.0.0) contiene 33 recetas originales:
- 12 de misterio/OVNI;
- 13 de documental/historia (corrección 2 añade `doc-schematic-diagram`, `doc-data-card` y `doc-neutral-atmosphere`);
- 8 de Reel/anuncio vertical.

Las fichas de abajo son las de la v1. La versión vigente añade a cada receta la regla `select` y cambia el movimiento de `doc-map-route` y `doc-timeline-graphic` a `graphic_animation`; el archivo JSON es la referencia.

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

| Fixture | Programa | Storyboard actual: shots | Shots de más de 8 s | Rótulos de texto de más de 3 s | Propuesta: shots | Cobertura | Duplicados | Variedad | Máx. misma receta seguida | Material nuevo | Licencias pendientes | Coste máx. estimado (USD) | Issues |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gobekli-storyboard-003 + script-003 | 660 s | 45 (planeación) | 45 | 17 | 90 | 100% | 0 | 0.7 | 1 | 62 | 11 | 3.1 | LICENSE_PENDING×11, BUDGET_EXCEEDED |
| gobekli-storyboard-002-hybrid + script-002 | 502 s | 44 (planeación) | 39 | 15 | 68 | 100% | 0 | 0.6 | 1 | 46 | 16 | 2.3 | LICENSE_PENDING×16, BUDGET_EXCEEDED |
| gobekli-storyboard-001 + script-002 | 502 s | 44 (planeación) | 39 | 15 | 68 | 100% | 0 | 0.6 | 1 | 39 | 23 | 1.95 | LICENSE_PENDING×23, BUDGET_EXCEEDED |

Cómo leer esta tabla:
- **Los conteos no son comparables 1:1.** Los shots del storyboard son unidades de planeación que el pipeline subdivide después (`shotsForSpan`).
- **Objetivos alcanzados:** 100 % de contrato, duración y cobertura; 0 duplicados; 0 llamadas y 0 cargos.
- **`BUDGET_EXCEEDED` es el resultado correcto.** La comparación no autoriza presupuesto (0 USD), y el inventario derivado del storyboard tiene menos recursos que planos de 8 s o menos sin repetir. El director **no reutiliza** recursos para rellenar: declara lo que falta como material nuevo.
- **Variedad, alineación frase-imagen y calidad visual son estimaciones** sin validar, porque no hay anotación humana. Que el JSON valide no demuestra una mejor calidad visual.

### Diferencias tras la corrección 1 (T-20261012-0318-chatgpt-19)

Cobertura, duplicados, variedad, material nuevo y coste estimado no cambian. Lo que sí cambia:

- **Licencias pendientes.** La puerta ahora informa `LICENSE_PENDING` en cada recurso elegido con licencia `NEEDS_REVIEW`: 11, 16 y 23 planos según el storyboard. Esos planos quedan pendientes, nunca aprobados.
- **Gráficos internos.** Los diagramas y mapas deterministas se consideran material interno, sin licencia de terceros, porque se dibujan desde el guion y no dependen de ningún archivo externo (lo dice el propio storyboard).
- **Más comprobaciones en la puerta.** No confía en los campos del plan:
  - **Referencias:** recursos, segmentos, recetas, versiones y catálogo deben existir.
  - **Licencias:** NOT_CLEARED se rechaza; NEEDS_REVIEW queda pendiente.
  - **Procedencia:** se deriva del inventario, y cada procedencia exige su etiqueta.
  - **Coste:** se recalcula desde `newMaterial` y los costes unitarios de entrada.
  - **Vídeo IA:** se rechaza si `allowAiVideo=false`.
  - **Línea de tiempo:** cada shot debe cumplir end > start y quedar dentro de su segmento; las anclas no pueden estar vacías.
  - **Avatar bloqueado:** se mantiene en un único shot con sus límites exactos y conserva su etiqueta de IA.

### Corrección 2 (T-20261012-0555-chatgpt-20): política documental, compatibilidad y anclaje

Responde a la auditoría editorial de Codex. Lo que cambia en el módulo:

- **Política documental por unidad narrativa** (`policy.ts`, `documentary-policy@1`). Clases, de la más restrictiva a la menos: restos humanos, evidencia específica, dato medible, hipótesis/negación y atmósfera. Primero cuentan los metadatos del storyboard y las afirmaciones del guion; el léxico solo alerta o restringe, nunca aprueba. Una afirmación no verificada, una negación o un matiz marcan la frase como no confirmada.
  - Restos humanos: evidencia real o tarjeta de texto; un diagrama esquemático aprobado en el storyboard queda en revisión; si la frase no está confirmada, solo tarjeta de texto. Nunca recreación ni material ilustrativo.
  - Evidencia específica y dato medible: evidencia real, gráfico o tarjeta deterministas; un ilustrativo planificado en el storyboard para ese tema queda en revisión; nunca material nuevo generado.
  - Hipótesis o negación: tarjeta o gráfico; una atmósfera neutral declarada solo si hay tarjeta de texto en el mismo tramo, y siempre en revisión.
  - «restos de plantas» no son restos humanos y «hueso» suelto solo genera una alerta.
- **Primero el recurso, después la receta.** El recurso se elige por los temas de la frase y por el plan del storyboard (beat y ventana temporal). La receta debe aceptar el tipo visual de ese recurso según su regla `select`. La rotación solo desempata recetas igual de compatibles. Si no hay recurso o receta compatibles, el plano queda **pendiente** con su motivo; nunca se rellena por rotación.
- **Tarjetas y diagramas del storyboard** no se usan fuera de su beat. Un gráfico puede sostenerse en planos consecutivos solo dentro del tiempo que el storyboard le asignó.
- **Anclaje por unidades de sentido.** Programa dinámico sobre límites de palabra que prefiere fin de oración, luego cláusula, y solo corta entre palabras si una oración excede el máximo (y lo declara). Usa marcas de palabra si existen; si no, la alineación queda como estimada y no validada.
- **Movimiento honesto.** Movimiento real solo con un clip real o con vídeo IA autorizado. Con una imagen fija, la regla de la receta decide entre fijo justificado, zoom declarado o pendiente. Mapas y líneas de tiempo usan `graphic_animation`, solo sobre gráficos deterministas.
- **La puerta recalcula la política** desde la entrada y añade `POLICY_MISMATCH`, `POLICY_VIOLATION`, `POLICY_REVIEW`, `DECISION_PENDING`, `RECIPE_INCOMPATIBLE` y `MOVEMENT_INCOMPATIBLE`. `POLICY_REVIEW` y `DECISION_PENDING` bloquean `ok`.
- **Informe por secuencia** (`report.ts`): repetición conceptual, tipos de plano, movimiento propuesto frente al declarado en el inventario, pendientes y revisiones.

| Fixture | Planos | Propuestos / débiles / pendientes | Restos / evidencia / dato / hipótesis / atmósfera | Violaciones de política | Revisiones | Atmósferas neutrales | Material nuevo | Movimiento real | Cortes oración / cláusula / palabra | Repeticiones conceptuales | USD estimado |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gobekli-storyboard-003 + script-003 | 106 | 73 / 9 / 24 | 5 / 27 / 16 / 20 / 38 | 0 | 15 | 16 | 25 | 2 | 66 / 38 / 2 | 35 | 1.25 |
| gobekli-storyboard-002-hybrid + script-002 | 80 | 55 / 8 / 17 | 0 / 21 / 11 / 14 / 34 | 0 | 10 | 14 | 22 | 3 | 54 / 25 / 1 | 19 | 1.1 |
| gobekli-storyboard-001 + script-002 | 80 | 56 / 8 / 16 | 0 / 18 / 11 / 16 / 35 | 0 | 17 | 15 | 23 | 3 | 54 / 25 / 1 | 20 | 1.15 |

Cómo leer esta tabla:
- **Más pendientes y revisiones no es un empeoramiento:** son los planos que antes se rellenaban por coincidencia léxica o rotación y ahora se declaran.
- **sb002h y sb001** comparten casi todos los recursos (78 de 80 planos con el mismo recurso, o sin recurso en ambos), así que sus recetas coinciden en 77 de 80 planos: ahora la receta sigue al recurso, no al guion.
- **Nada de esto es calidad cinematográfica validada.** Los temas salen de un léxico, los tiempos son estimados y no hay bytes de imagen. La puerta sigue en `ok=false` por licencias, presupuesto, revisiones y pendientes.

### Corrección 3 (T-20261012-0712-chatgpt-21): correspondencia factual y tope de atmósfera neutral

Esta corrección cierra los dos defectos que dejó abiertos la corrección 2.

- **Correspondencia factual.** Una tarjeta, cita, mapa, cronología o diagrama determinista del storyboard (un `data_graphic` con ventana planificada) solo puede ilustrar la narración para la que se planificó. Lo comprueba `factualCorrespondence` en `policy.ts`, y tanto el módulo como la puerta usan esa misma función:
  - El plano debe solaparse con la ventana del recurso en al menos el 30 % de su duración.
  - Si el recurso y la frase corresponden a afirmaciones distintas del guion, se rechaza. Los años cuentan como clave fuerte.
  - La única excepción es una continuación explícita: contigua, en el mismo segmento y dentro de la duración que el storyboard le asignó.
  - Si no hay un recurso compatible, el plano queda pendiente.
  - La base de la decisión (ventana, solape y afirmación) queda registrada en `decision.assetBasis`.
  - La puerta emite `FACTUAL_MISMATCH` si se fuerza un recurso fuera de su ventana, contra otra afirmación o sostenido más tiempo del planificado.
- **Caso sb003 beat-10.**
  - El rumor no confirmado de 2026 (`beat-10-s3`) ya no recibe la cita de 2017 (`b10-s3`). Ahora muestra la tarjeta de transparencia `b10-s1`, que continúa sin cortes dentro de su ventana de 469 a 485 s.
  - La cita de 2017 solo aparece en los planos sobre el estudio de 2017.
- **Atmósfera neutral.** Sigue siendo una pausa declarada y revisable, con dos topes: como máximo el 10 % de los planos del plan y una por secuencia.
  - Si se supera un tope, el plano queda pendiente; no se rellena con otra recreación.
  - El módulo no emite justificaciones para superar el tope. La puerta emite `NEUTRAL_EXCESS`, y las métricas `neutralShots`, `neutralPct` y `maxNeutralPerSequence` registran los recuentos.
- **Continuidad de receta.** Una continuación conserva la receta del plano al que continúa.

| Fixture | Planos | Propuestos / débiles / pendientes | Atmósfera neutral | Máx. por secuencia | Desajustes factuales | Violaciones de política | Revisiones | Material nuevo | Repeticiones conceptuales | USD estimado |
|---|---|---|---|---|---|---|---|---|---|---|
| gobekli-storyboard-003 + script-003 | 106 | 68 / 11 / 27 | 9 (8.5 %) | 1 | 0 | 0 | 10 | 17 | 45 | 0.85 |
| gobekli-storyboard-002-hybrid + script-002 | 80 | 49 / 11 / 20 | 7 (8.8 %) | 1 | 0 | 0 | 6 | 14 | 20 | 0.7 |
| gobekli-storyboard-001 + script-002 | 80 | 49 / 11 / 20 | 7 (8.8 %) | 1 | 0 | 0 | 12 | 14 | 22 | 0.7 |

Cómo leer la tabla:
- Hay más pendientes que en la corrección 2: el exceso de relleno neutral ahora queda pendiente.
- Las repeticiones conceptuales cuentan también las continuaciones de una misma tarjeta, que el informe marca con `continuation`.
- La calidad cinematográfica sigue sin validar.

## 7. Impacto esperado (estimaciones, no facturación)

- **Latencia del modo propuesta:** milisegundos (O(segmentos × recetas)); no usa red.
- **Coste con `allowAiVideo=false`:** con los costes unitarios del plan de producción (imagen IA USD 0,05; clip Veo USD 0,96), tras la corrección 3, las tres comparaciones estiman entre USD 0,70 y 0,85 de imágenes nuevas para 8–11 minutos (antes 1,95–3,10). Baja porque las frases sensibles y el exceso de relleno neutral ya no generan material: quedan pendientes.
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
