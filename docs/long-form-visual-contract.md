# Long Form — contrato de integración visual (M1 → montaje/render)

Estado: propuesto por el responsable de planificación/selección (M1). No
modifica `remotion/LongFormDoc.tsx`, `remotion/audio-mix.ts` ni el mastering.

## 1. Qué produce M1 (planes `version >= 3`)

Por escena (`Shot`, aditivo y opcional; planes v1/v2 no lo traen):

| Campo | Significado |
|---|---|
| `narrationFragment` | Texto narrado DURANTE la escena (tiempos reales por palabra en ejecución). |
| `anchoredVisual` | Intención: `description`, y si el guion los declara `quote`, `subject`, `action`, `place`, `era`, `alternates`. |
| `intentAnchor` | `{ visualIndex, reuseIndex, anchoredBy: "quote" \| "order" }`. `reuseIndex > 0` = escenas consecutivas del mismo pasaje (distinto recurso). |

Por recurso (registro durable `${requestId}/state/shots/<shot>.<kind>.json`):

| Campo | Significado |
|---|---|
| `identity` | `provider`, `sourceId`, `canonicalUrl`, `sha256`, `dhash` (o `dhashUnavailable`). |
| `provenance.kind` | `stock_illustrative` (archivo moderno que ilustra), `ai_recreation` (IA), `archival_documentary` (reservado: ningún proveedor lo entrega hoy). |
| `provenance.license/author/pageUrl` | Licencia declarada por el proveedor (no revisión legal), autor y página. |
| `selection` | `query`, `tier`, `relevance` (`keyword_match` \| `unverified` \| `generated_from_intent`), `matchedTerms`, `candidateDescription`, rechazos. |

Informe previo al render: `${requestId}/state/visual-report.json` (`VisualReport`,
`src/lib/video/long-form/visual-report.ts`): escenas, recursos únicos,
repeticiones (con `justification` opcional), cobertura video/imagen/tarjeta,
escenas inciertas, carencias y ventana inicial (60 s).

Garantías en v3: 0 recursos repetidos sin justificación (bloquea ANTES del
render), 0 tarjetas con el título del documental, sin búsqueda por el tema
general, carencias explícitas (tarjeta con el pasaje + desviación registrada).

## 2. Lo que NO garantiza M1

- La pertinencia es léxica (intención vs. texto del proveedor). No hay
  análisis del contenido de la imagen. `unverified` = sin texto del proveedor
  o intención derivada de la narración (guiones sin `visuals`).
- dHash de imagen completa / un fotograma: no detecta recortes fuertes,
  espejados, otro ángulo del mismo sujeto; imágenes casi planas pueden dar
  falsos positivos (del lado seguro).
- Stock de Pexels es moderno: sirve para ilustrar, no para documentar 1904-1914.

## 3. Lo que M1 necesita de montaje/render (Work)

1. **Rótulo de recreación IA**: cuando `provenance.kind === "ai_recreation"`,
   mostrar un rótulo discreto ("Recreación") — hoy el render no lo distingue.
2. **Tarjetas**: hoy título 40 px / cuerpo 32 px sobre 1920×1080. Las
   tarjetas v3 son cortas (título = dato o pasaje ≤ 90 caracteres, cuerpo ≤ 110
   o vacío); proponemos título ≥ 72 px y cuerpo ≥ 44 px.
3. **Escenas consecutivas del mismo pasaje** (`reuseIndex > 0`): candidatas a
   transición suave / continuidad, no a corte duro.
4. **Carencias** (`visual-report.summary.gaps`): decidir tratamiento editorial
   (extender la escena anterior, gráfico, o pedir recurso) — M1 no alarga
   escenas para no romper los tiempos del plan confirmado.

Cambios a interfaces compartidas con Remotion: ninguno en M1. Si Work
necesita `provenance` dentro de `LongFormShotScene`, propuesta de campo
aditivo: `scenes[i].provenance?: "stock_illustrative" | "ai_recreation" | "archival_documentary"`.
