# VIDEO #001 — Göbekli Tepe — Prueba visual híbrida-premium

**Estado: BLOQUEADO antes del gasto — no por presupuesto, sino por credenciales.**

Todo lo gratuito de esta fase está completo (reclasificación del storyboard, prompts diseñados, costo estimado, mapa verificado). **Las 3 imágenes de prueba NO se generaron**: `OPENAI_API_KEY` no está configurada en este entorno — el mismo bloqueo técnico reportado en Fase A y en el research pack, todavía sin resolver. No te pedí la clave en el chat, tal como se estableció antes. En cuanto exista una vía segura para la credencial (Vercel u otro entorno con secretos), los prompts de abajo están listos para ejecutarse tal cual, sin ningún trabajo adicional.

---

## 1-6. Storyboard reclasificado (estrategia híbrida-premium)

Archivo: `gobekli-storyboard-002-hybrid.json` (nuevo — el original `gobekli-storyboard-001.json` se conserva sin cambios, tal como pediste).

Cada uno de los 44 shots tiene ahora `hybridClassification` + `hybridReason`. **Sin cuota artificial** — cada AI_RECREATION se justifica individualmente por impacto visual y ausencia de riesgo factual.

| Categoría | # | Criterio aplicado |
|---|---|---|
| **REAL_DOCUMENTARY** | 7 | Evidencia arqueológica específica (pilares, relieves, estructuras) — nunca sustituida por IA, tal como pediste explícitamente |
| **STOCK_REAL** | 8 | Material genérico real donde el stock cubre bien la necesidad sin sacrificar nada |
| **DETERMINISTIC** | 6 | Mapa, timeline, comparación de escala, diagrama B/C/D, diagrama de asociación, diagrama conceptual — todo dato medible o cita textual, nunca IA |
| **AI_RECREATION** | 8 | Atmósfera de tiempo profundo, escenas humanas no documentales, síntesis conceptual, momentos de alto impacto cinematográfico — nunca donde haya evidencia específica en juego |
| **TEXT** | 15 | Tarjetas de texto (citas, incógnitas, tesis, transiciones) |
| **TOTAL** | **44** | |

### Los 8 shots AI_RECREATION (con justificación individual)
| shotId | Beat | Por qué IA aquí |
|---|---|---|
| b1-s1 | 1 | Establishing shot de Anatolia hace 11,000 años — stock moderno rompería la inmersión (carreteras, vegetación actual) |
| b1-s5 | 1 | Cierre atmosférico del hook, sin nueva evidencia |
| b4-s4 | 4 | Escena humana de cooperación/escala, SIN mostrar método de construcción — ver Prueba B abajo |
| b7-s1 | 7 | Representa la "versión popular" (narrativa a corregir, no evidencia) — tratamiento visual deliberadamente distinto para separarla de la evidencia real |
| b7-s4 | 7 | Síntesis conceptual (vida cotidiana + monumental) — difícil de encontrar como foto real única |
| b9-s2 | 9 | Pausa contemplativa, puro valor atmosférico |
| b9-s4 | 9 | Cierre atmosférico del beat, mismo criterio |
| b10-s1 | 10 | Momento de alto impacto emocional de cierre — ver Prueba C abajo |

**Ningún shot con `factualSensitivity: high` fue reclasificado a AI_RECREATION.** Los 7 REAL_DOCUMENTARY y los shots deterministic/high-sensitivity (mapa, timeline, escala, diagrama B/C/D, asociación de hallazgos) se mantienen exactamente como en la v1.

---

## 7-8. Las 3 imágenes de prueba — prompts y parámetros (listos, NO ejecutados)

**Identidad visual común a las 3** (para consistencia entre ellas y con el resto del documental):
- Realismo fotográfico documental — nunca estilo "pintura" ni look de IA genérico
- Iluminación natural únicamente (amanecer/atardecer/luz difusa), sin iluminación de estudio artificial
- Gradación de color: tonos tierra cálidos (ocre, siena, dorado polvoriento) con sombras frías desaturadas — estética de documental premium
- Grano de película sutil, composición panorámica tipo anamórfico
- Cero elementos modernos (sin caminos, cableado, ropa contemporánea, metal, escritura)
- Sin texto ni marca de agua incrustados
- 16:9, `size: "1536x1024"`, `model: "gpt-image-2"`, `quality: "medium"` (ver nota de costo)

### Prueba A — establishing shot, Anatolia hace ~11,000 años (shot b1-s1)
```
Wide cinematic establishing shot of the Anatolian highlands at dawn,
~11,000 years ago (Pre-Pottery Neolithic). Rolling semi-arid hills under
a vast pale gold sky, dry grasses and scattered stone outcrops, absolutely
no modern structures, roads, or present-day vegetation patterns.
Photographic documentary realism, natural light only, warm earth-tone
color grading with desaturated cool shadows, subtle film grain, anamorphic
widescreen composition, atmospheric haze suggesting deep time and vast
scale. No people, no text, no watermark.
```
Negativo/evitar: *no modern buildings, no roads, no power lines, no contemporary clothing, no text overlays, no fantasy elements, no aliens, no futuristic technology*

### Prueba B — escena humana atmosférica, cooperación sin método específico (shot b4-s4)
```
Cinematic wide shot at dusk: distant silhouettes of a small group of
people standing together on a hillside near massive half-buried stone
shapes, scale emphasized by distance and low warm light. Figures are
anonymous silhouettes — no visible clothing detail, tools, or specific
activity that could be mistaken for a documented technique. Mood of
quiet cooperation and scale, not action. Photographic documentary
realism, warm dusk color grading, subtle atmospheric haze, film grain,
anamorphic widescreen. No text, no watermark.
```
Negativo/evitar: *no visible tools, no specific construction technique, no visible clothing details, no ropes or pulleys shown explicitly, no close-up faces, no modern elements*

*Nota de rigor:* deliberadamente en silueta y a distancia — evita mostrar cualquier método de transporte/construcción concreto, exactamente lo que pediste no inventar.

### Prueba C — momento cinematográfico de alto impacto (shot b10-s1)
```
Cinematic golden-hour wide shot: silhouettes of massive T-shaped stone
pillars atop a hill against a warm setting sun, seen from a respectful
distance — no carved details visible, just powerful silhouette forms
suggesting ancient monumental architecture. Warm golden and amber tones,
soft atmospheric haze, photographic documentary realism, subtle film
grain, anamorphic widescreen composition, contemplative and awe-inspiring
mood. No people, no text, no watermark, no modern elements.
```
Negativo/evitar: *no visible carvings or reliefs (evita implicar detalle iconográfico documentado a esta distancia), no modern structures, no fantasy/sci-fi elements, no text*

*Nota de rigor:* silueta a distancia, sin tallados visibles — nunca se presenta como fotografía documental de un relieve real.

---

## 9. Costo — 3 imágenes de prueba

| | |
|---|---|
| Modelo/tamaño/calidad | gpt-image-2, 1536x1024, **medium** (config. por defecto del proyecto — elegido deliberadamente para dejar margen bajo tu tope de $0.50) |
| Estimación estática por imagen (`ESTIMATED_COST_USD`, ya configurada en el proyecto) | $0.05 |
| **3 imágenes** | **≈ $0.15** (muy por debajo de tu tope de $0.50) |
| Costo REAL de las 3 imágenes | **No disponible — no se ejecutó la llamada** (ver bloqueo abajo) |

**No se necesitó detenerse por presupuesto** — el estimado ($0.15) deja margen amplio bajo tu autorización de $0.50, incluso considerando variación real por tokens de salida.

### Bloqueo — por qué no se generaron
`OPENAI_API_KEY` no está configurada en este entorno (sandbox de esta sesión). Confirmado por segunda vez en este mensaje (`echo $OPENAI_API_KEY` → vacío). Este es el mismo bloqueo técnico reportado en el reporte de Fase A y en la entrega del research pack — sigue sin resolverse. No pedí la clave en el chat. En cuanto la credencial esté disponible en un canal seguro, ejecutar es inmediato: los 3 prompts de arriba con esos parámetros exactos, vía el mismo `openaiImageProvider` ya integrado y probado (`src/lib/providers/image/openai.ts`, con soporte landscape 16:9 ya construido en Fase A).

---

## 10. Costo proyectado del documental completo — estrategia híbrida

| Partida | Cálculo | Costo |
|---|---|---|
| TTS (ElevenLabs, sin cambios) | 9,010 caracteres × $0.10/1k | ≈ $0.90 |
| AI images — calidad **medium** (8 shots) | 8 × $0.05 | ≈ $0.40 |
| AI images — calidad **high** (8 shots, estimado aproximado) | 8 × ~$0.15–0.20* | ≈ $1.20–1.60 |
| Stock real (Pexels, 15 shots) | gratis | $0 |
| Determinístico (6 shots) | gratis | $0 |
| Render + storage | gratis (local, ya validado) | $0 |
| **TOTAL — calidad medium** | | **≈ $1.30** |
| **TOTAL — calidad high** | | **≈ $2.10–2.50** |

*\*La tarifa "high" no está calibrada en el proyecto (solo "medium" tiene `ESTIMATED_COST_USD` configurado) — es una aproximación basada en el patrón de precios por token ya documentado en `openai.ts` (salida ~$40/1M tokens), no una cifra verificada. Se confirmaría con la primera llamada real.*

Sigue siendo razonable y muy por debajo del techo de $12 ya configurado en `LONG_FORM_MAX_TOTAL_USD`. Tú decides el nivel de calidad para producción final — no se ha tomado esa decisión aquí.

---

## 11. Verificación del mapa

**Coordenadas usadas:** 37.22°N, 38.92°E (precisión reducida a ~1km, como pediste si no se puede verificar contra fuente primaria).

**Lo que pude verificar:** múltiples fuentes secundarias convergen en la misma zona (Wikidata Q214944, agregadores de coordenadas GPS) — dos valores citados fueron 37.2205°N/38.9201°E y 37.22361°N/38.92167°E (difieren ~300-400m en el tercer decimal). Ubicación regional confirmada: cerca de Örencik, ~12km al noreste de Şanlıurfa, sureste de Turquía — consistente con "montañas Germuş, sureste de Turquía" del research pack.

**Lo que NO pude verificar directamente:** el documento oficial de UNESCO (`whc.unesco.org/document/160483`) y la página de mapas de UNESCO (`whc.unesco.org/en/list/1572/maps/`) están bloqueados por el proxy de salida de red de este entorno — igual que Wikipedia. No pude leer la fuente primaria/institucional tal cual, solo agregadores secundarios que la citan.

**Por eso:** el mapa usa precisión reducida (2 decimales, ~1km) en vez de un punto exacto de alta precisión, tal como indicaste para este caso.

Fuentes consultadas: [Göbekli Tepe — Wikidata](https://www.wikidata.org/wiki/Q214944) · [UNESCO World Heritage Centre — Maps](https://whc.unesco.org/en/list/1572/maps/) (referenciada, no leída directamente) · [latitude.to — Göbekli Tepe](https://latitude.to/articles-by-country/tr/turkey/659/gobekli-tepe)

---

## 12. Riesgos visuales/históricos detectados

1. **Bloqueo de credenciales (OpenAI)** — impide validar hoy si el estilo visual diseñado realmente luce como se espera. Sigue siendo el mismo bloqueo de Fase A/research pack.
2. **Bloqueo de egress de red** hacia UNESCO/Wikipedia impidió leer la fuente primaria del mapa directamente — mitigado con precisión reducida, no con una coordenada inventada.
3. **b7-s1 (versión popular)** usa IA deliberadamente con un tratamiento "más mítico" — riesgo menor de que, si se ejecuta mal, esa estilización se perciba como la versión "real" en vez de la narrativa a corregir. Mitigación: mantener el tratamiento visual claramente distinto (más "ilustrativo") del resto del documental, y considerar en Fase B añadir una superposición textual breve tipo "creencia popular" si el resultado no se distingue con suficiente claridad.
4. **b4-s4 y b7-s4 (siluetas humanas)** — riesgo de que, sin supervisión visual directa del resultado real, el modelo de IA introduzca por defecto ropa/herramientas/posturas que sugieran un periodo o cultura incorrectos. Mitigación ya incluida en los prompts (negativos explícitos) — debe verificarse visualmente en cuanto se puedan generar las pruebas reales.
5. **Disponibilidad real de stock** para los 15 shots REAL_DOCUMENTARY/STOCK_REAL sigue sin confirmarse (no se ejecutaron búsquedas reales en Pexels) — mismo riesgo ya señalado en el plan de producción original.
