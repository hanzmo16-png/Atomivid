# ATOMIVID Long Form — Visual Bible v1

**Alcance:** guía de identidad visual y de decisión de assets para todos los documentales 16:9 de ATOMIVID Long Form (no solo Göbekli Tepe). Generaliza el criterio ya aplicado y validado en `content/long-form/gobekli-tepe-001/gobekli-visual-test-001.md` y `gobekli-storyboard-003.json`, para que el próximo video no tenga que redescubrir estas reglas desde cero.
**Estado:** v1 — derivada de un solo caso de estudio (Göbekli Tepe). Debe revisarse y ampliarse después de que se produzcan 2-3 videos reales.
**No implica ningún cambio de código.** Es un documento de criterio editorial/creativo, consumido por humanos (y por el propio Claude en checkpoints futuros) al diseñar storyboards.

## 1. Principio rector

**Calidad, retención y rigor por encima de la minimización de costo — pero la evidencia arqueológica/factual específica NUNCA se sustituye por IA.** No existe una cuota fija de imágenes generadas. Cada shot se clasifica individualmente, con una razón explícita y auditable (`hybridReason`), no por una regla mecánica de porcentaje.

## 2. Taxonomía de clasificación de assets (5 categorías)

| Categoría | Qué es | Regla de uso |
|---|---|---|
| **REAL_DOCUMENTARY** | Fotografía/video real de la evidencia específica (un pilar concreto, un artefacto concreto, restos humanos, una estructura concreta) | Obligatoria siempre que exista evidencia arqueológica/factual específica en juego. Nunca sustituida por IA, sin excepción. |
| **STOCK_REAL** | Fotografía/video real pero genérico (tipo de artefacto, escena de excavación ilustrativa, paisaje regional) | Se usa cuando el stock cubre bien la necesidad sin fingir ser la evidencia exacta del caso — y se declara así en `description`/`sourceRequirement` para que nunca se confunda con documentación literal. |
| **DETERMINISTIC** | Mapa, diagrama, línea de tiempo, tarjeta de texto — generado por código, no por IA generativa | Obligatoria para cualquier dato medible (fechas, coordenadas, cifras, geometría, citas textuales). Prioriza trazabilidad sobre estética. |
| **AI_RECREATION** | Imagen generada por IA (OpenAI, `landscape` 16:9) | Solo para: atmósfera/tiempo profundo, escenas humanas explícitamente no documentales (sin método/técnica/rostro específico), síntesis conceptual, momentos de alto impacto cinematográfico sin afirmación factual nueva. **Nunca** donde haya evidencia arqueológica específica o restos humanos identificables en juego. |
| **TEXT** | Tarjeta de texto determinística | Preferida sobre imagen para cualquier claim de `factualSensitivity: high` o cualquier hedge que deba leerse literal (p. ej. "evaluadas como posiblemente residenciales") — una imagen sola no puede transmitir un matiz de certeza con precisión. |

### 2.1 Reglas duras (no negociables, validadas en Göbekli Tepe v.003)

1. **Restos humanos identificables → siempre REAL_DOCUMENTARY o TEXT, nunca AI_RECREATION.** Generar una imagen de "restos humanos genéricos" por IA para ilustrar un hallazgo real es inaceptable: puede leerse como documentación falsa de algo que no se está mostrando de verdad.
2. **Un hallazgo condicional/hedged (p. ej. "podrían ser viviendas") solo puede ilustrarse con AI_RECREATION si va acompañado, en el mismo tramo, de una tarjeta de texto o narración que preserve el hedge literal.** La imagen sola nunca debe sugerir más certeza que la fuente.
3. **La "creencia popular a corregir" (un mito o narrativa simplificada que el documental va a matizar) debe tener un tratamiento visual perceptiblemente distinto del resto del documental** (más estilizado/ilustrativo), para que la audiencia no la confunda con la evidencia real presentada después.
4. **Geografía y cronología siempre DETERMINISTIC.** Un mapa o una línea de tiempo generados por IA pueden inventar una coordenada o una fecha con apariencia de precisión — inaceptable.
5. **Ninguna imagen IA lleva texto ni marca de agua incrustada** — los textos van siempre en la capa de `TextGraphic` del pipeline, nunca quemados en el prompt de imagen.

## 3. Identidad visual compartida (para consistencia entre shots y entre videos)

Todo prompt de `AI_RECREATION` de ATOMIVID Long Form debe incluir estos elementos, para que las 3+ imágenes de un mismo documental —y de documentales futuros de la misma línea editorial— se sientan parte de una sola serie:

- **Realismo fotográfico documental** — nunca estilo "pintura" ni el look genérico reconocible de IA.
- **Iluminación natural únicamente** (amanecer/atardecer/luz difusa) — nunca iluminación de estudio artificial.
- **Gradación de color:** tonos tierra cálidos (ocre, siena, dorado polvoriento) con sombras frías desaturadas — estética de documental premium.
- **Grano de película sutil**, composición panorámica tipo anamórfico.
- **Cero elementos modernos** — sin caminos, cableado, ropa contemporánea, metal moderno, escritura.
- **Sin texto ni marca de agua** incrustados en la imagen.
- **Parámetros técnicos por defecto:** `model: "gpt-image-2"`, `size: "1536x1024"` (landscape 16:9), `quality: "medium"` salvo decisión explícita en contrario del usuario para una producción concreta.

### 3.1 Bloque de negativos estándar (copiar/adaptar en cada prompt)

```
no modern buildings, no roads, no power lines, no contemporary clothing,
no visible tools or specific construction technique (a menos que el shot
lo requiera y esté explícitamente aprobado), no ropes or pulleys shown
explicitly, no close-up identifiable faces, no text overlays, no watermark,
no fantasy elements, no aliens, no futuristic technology, no visible
carvings/reliefs a menos que se trate de un REAL_DOCUMENTARY verificado
```

### 3.2 Tratamiento para escenas humanas no documentales

Cuando un shot `AI_RECREATION` incluye figuras humanas (cooperación, vida cotidiana, construcción), usar **siluetas a distancia, sin detalle de ropa/herramientas/rostro específico** — nunca una escena de "acción" que implique documentar una técnica no verificada. Esto evita afirmar visualmente algo que el guion explícitamente se niega a afirmar en texto (p. ej. "no sabemos el método exacto de transporte").

## 4. Registro de derechos/licencia (para REAL_DOCUMENTARY / STOCK_REAL)

Todo shot `REAL_DOCUMENTARY` o `STOCK_REAL` en un storyboard debe llevar un objeto `licensing`:

```json
{
  "source": "string — banco/biblioteca o 'pendiente de selección manual'",
  "url": "string | 'Por resolver en tiempo de render' | 'No asignado en este checkpoint'",
  "license": "string",
  "licenseUrl": "string opcional",
  "attribution": "string — si se requiere y qué texto",
  "commercialUsePermitted": "boolean | null",
  "modificationPermitted": "boolean | null",
  "status": "CLEARED | NOT_CLEARED | NEEDS_REVIEW"
}
```

- **CLEARED** — la licencia de la *clase* de fuente es inequívocamente segura para uso comercial (p. ej. Pexels License: gratis, sin atribución requerida, uso y modificación comercial permitidos), aunque el archivo exacto se resuelva por query en tiempo de render (mismo patrón que `src/lib/providers/footage/`).
- **NEEDS_REVIEW** — evidencia específica (un artefacto, una persona, un sitio concreto) donde un banco de stock genérico probablemente no tiene material preciso; requiere selección manual de una fuente verificable individualmente (Wikimedia Commons con licencia CC confirmada por archivo, material de prensa con permiso explícito, etc.) antes de producción real.
- **NOT_CLEARED** — se identificó una fuente con licencia conocida-incompatible (uso no comercial, prohibición de modificación, etc.); no se usa bajo ninguna circunstancia sin resolver la licencia primero.

## 5. Checklist rápida al diseñar un storyboard nuevo

1. ¿Este shot representa evidencia factual específica (artefacto, persona, estructura, fecha, coordenada)? → REAL_DOCUMENTARY o DETERMINISTIC. Nunca AI.
2. ¿Involucra restos humanos identificables? → REAL_DOCUMENTARY o TEXT. Nunca AI, sin excepción.
3. ¿Es una afirmación con hedge (posible, podría, se evalúa)? → el hedge debe aparecer en TEXT o narración; si además hay imagen, debe ser claramente presentada como recreación condicional.
4. ¿Es atmósfera, tono, o una escena humana genérica sin afirmación factual nueva? → AI_RECREATION es aceptable, con el bloque de identidad visual compartida (sección 3).
5. Si es REAL_DOCUMENTARY o STOCK_REAL: ¿tiene su objeto `licensing` completo, con `status` honesto? Si no hay fuente asignada todavía, `status: "NEEDS_REVIEW"`, nunca `"CLEARED"` por defecto.

## 6. Historial de este documento

- **v1 (este archivo):** derivada del caso Göbekli Tepe (`gobekli-visual-test-001.md` + `gobekli-storyboard-003.json`), checkpoint de actualización 2026. Ningún prompt de este documento ha sido ejecutado todavía — `OPENAI_API_KEY` sigue sin configurar en este entorno.
