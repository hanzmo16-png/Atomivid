# VIDEO #001 — Göbekli Tepe — Plan de producción (preproducción)

**Estado:** preproducción completa. Cero llamadas pagadas realizadas. Detenido antes de Fase B (voz/assets/render) a la espera de tu autorización.

Archivos de este paquete (todos en `content/long-form/gobekli-tepe-001/`):
- `gobekli-script-002-final.md` / `.json` — guion final auditado
- `gobekli-storyboard-001.json` — 44 shots de producción
- `gobekli-production-plan-001.md` — este documento

---

## 3. Storyboard de producción — resumen

**44 shots** (objetivo 35–55 ✓), cubriendo los 10 beats, duración total ≈ 501.5s (consistente con la duración estimada del guion, 501.4s).

Los "shots" del storyboard son unidades de **planeación creativa/abastecimiento** (~10-14s cada una en promedio). A la hora de renderizar, el pipeline real (`shotsForSpan()` en `src/lib/video/long-form/shots.ts`, ya validado en Fase A) subdivide automáticamente cada una en sub-shots de 3-8s con Ken Burns/crossfade — así se logra ritmo visual real sin tener que microgestionar cada corte fino aquí. **10 beats no son 10 imágenes**: son 44 unidades de producción que a su vez se convertirán en aproximadamente 60-100 sub-shots reales de 3-8s en el render final.

### Distribución por assetType (código real, compatible con el pipeline)
| assetType | shots |
|---|---|
| text | 15 |
| ken_burns_image | 11 |
| stock_image | 8 |
| diagram | 5 |
| stock_video | 4 |
| map | 1 |

### Distribución por categoría de producción (más descriptiva)
| Categoría | shots | Mapeo a assetType del pipeline |
|---|---|---|
| text | 15 | `text` (sin cambios) |
| documentary_image | 17 | `stock_image` — foto real/de archivo preferida sobre imagen generada |
| diagram | 4 | `diagram` (sin cambios) |
| stock_video | 3 | `stock_video` (sin cambios) |
| stock_image | 3 | `stock_image` (sin cambios) |
| map | 1 | `map` (sin cambios) |
| timeline | 1 | `diagram` — nodos ordenados cronológicamente, mismo renderer |

**generated_image (AI): 0 shots** en el diseño base — ver sección 5.

### Distribución por sensibilidad factual
- **Alta (12 shots):** mapa de ubicación, timeline de datación, comparación de escala, detalle de figuras/animales tallados, el diagrama B/C/D, asociación herramientas↔estructuras, estructuras domésticas. Todas con proveedor preferido `deterministic` o `pexels` (nunca `openai-image` como primera opción) y fallback explícito que NUNCA es una reconstrucción fotorrealista IA no verificada.
- **Media (11 shots):** b-roll ilustrativo genérico (paisaje, cantera, talla) — explícitamente marcado como ilustrativo, no como documentación del método real.
- **Baja (21 shots):** texto, atmósfera, transiciones, símbolos genéricos.

---

## 4. Exactitud visual — guardrails aplicados

1. **El diagrama B/C/D** (`b6-s2` en el storyboard) representa **únicamente** lo que Haklay & Gopher (2020) publicaron: tres nodos etiquetados B, C, D y la relación geométrica propuesta entre ellos. Sin coordenadas reales no verificadas, sin medidas inventadas, sin afirmar que el plan esté "demostrado". Su `fallback` es explícitamente **"NINGUNO — si no se puede construir respetando exactamente lo publicado, usar una tarjeta de texto"** — nunca una reconstrucción fotorrealista de "cómo se veía el plan".
2. **Ninguna reconstrucción arqueológica especulativa se trata como documentación real.** Los 17 shots `documentary_image` prefieren foto real de stock (Pexels); cuando el fallback es una ilustración, se especifica que debe leerse claramente como esquema/silueta — nunca como fotografía documental del sitio real.
3. **Mapas, timeline y la relación geométrica usan generación determinística** (código ya existente: `map`/`diagram` en `src/lib/video/long-form/diagram-map.ts`), no imágenes generadas por IA — exactamente como pediste.
4. **Advertencia pendiente de verificación:** el shot `b2-s1` (mapa de ubicación) necesita coordenadas reales verificadas contra una fuente primaria antes de producción — el research pack #001 da la ubicación en palabras ("montañas Germuş, sureste de Turquía") pero no coordenadas numéricas exactas. Esto queda marcado explícitamente en el storyboard (`factualSensitivity: "high"`) y **no debe resolverse con una coordenada de memoria sin verificar**.

---

## 5. Estrategia de assets y costo — prioridad aplicada

Prioridad usada al diseñar el storyboard, en este orden exacto:
1. **Material real/documental** cuando sea legal y técnicamente utilizable (stock genérico vía Pexels, marcado `documentary_image` cuando aplica al sitio/tema).
2. **Stock gratuito configurado** (Pexels — ya integrado, gratis, ver `src/lib/billing/pricing.ts`).
3. **Mapas, diagramas, timelines y gráficos determinísticos** (código ya existente, cero costo) — usados para TODO el contenido de mayor sensibilidad factual (datación, escala, geometría B/C/D, asociación de hallazgos).
4. **Imágenes IA** — el storyboard, tal como está diseñado, **no requiere ninguna** (0 de 44 shots la tienen como `preferredProvider`, y ningún `fallback` recurre a ella tampoco). Esto es deliberado: para este tema, el material determinístico y el stock genérico cubren toda la necesidad visual sin sacrificar precisión.

**Nota honesta sobre esta cifra de $0 en IA:** Pexels es una biblioteca de stock comercial genérica, no un archivo arqueológico — es posible que, al ejecutar la búsqueda real en Fase B, algunos de los 17 shots `documentary_image` (p. ej. "pilar en forma de T tallado", "relieve de animal salvaje en piedra") no encuentren una foto de stock suficientemente específica. En ese caso, el plan indica usar el fallback determinístico (diagrama esquemático) **antes que** recurrir a una imagen generada — pero si en Fase B decides que una imagen IA bien acotada (nunca fotorrealista, nunca inventando detalle iconográfico) da mejor resultado visual que el esquema para 1-2 shots puntuales, esa sería una decisión tuya en ese momento, no algo que este plan requiera.

---

## 7. Cost model — FREE vs. PAID

| Partida | Tipo | Costo |
|---|---|---|
| Guion (ya escrito en esta conversación) | FREE | $0 |
| Pexels (stock, ~22 de 44 shots) | FREE | $0 |
| Gráficos determinísticos — map/diagram/timeline/text (~21 de 44 shots) | FREE | $0 |
| Render local (Remotion, ya validado en Fase A) | FREE | $0 |
| Almacenamiento (Supabase) | FREE (dentro de plan actual) | ~$0 |
| **TTS (ElevenLabs, 9,010 caracteres, 10 llamadas — 1 por beat)** | **PAID** | **≈ $0.90** |
| **Imágenes IA (OpenAI, landscape 16:9)** — 0 requeridas por diseño | **PAID (contingente)** | **$0 base · hasta ≈ $0.50–0.70 si se opta por 8-10 de contingencia** |
| **TOTAL ESTIMADO** | | **≈ $0.90 (base) — ≈ $1.60 (con contingencia IA completa)** |

Esta cifra es notablemente más baja que la estimación de Fase A (~$2-5), porque aquella asumía ~10-15 imágenes generadas por defecto; este storyboard, siguiendo tu instrucción explícita de "no generar IA solo porque podemos", las evita por completo en el diseño base.

### APIs que se llamarían en Fase B (todavía NO llamadas)
- **ElevenLabs** — síntesis de voz, 10 llamadas (una por beat, cada una muy por debajo del límite de caracteres/request — ver `src/lib/video/long-form/timeline.ts`).
- **Pexels** — búsqueda/descarga de stock, gratis, ~22 queries (las queries están preparadas en el storyboard, ninguna se ejecutó).
- **OpenAI Images** — solo si decides usar la contingencia de imágenes IA para algún shot puntual; 0 llamadas planeadas por defecto.
- **Anthropic** — no se necesita ninguna llamada adicional; el guion ya está finalizado.
- **HeyGen / Runway / Beatoven** — no aplican a este video (modo documental visual, no avatar; música vía biblioteca curada gratuita).

---

## 9. Checklist de validación

- [x] `gobekli-script-002-final.json` — JSON válido (parseado con `python3 -m json.tool` exitosamente).
- [x] `gobekli-storyboard-001.json` — JSON válido, 44 shots.
- [x] Los 10 beats tienen shots asignados en el storyboard (verificado: `beat-1` … `beat-10`, todos presentes).
- [x] Todos los claims materiales están clasificados (31 claims: 13 sourced, 6 inference, 12 unverified — ninguno sin clasificar).
- [x] Todos los `sourceId` referenciados existen en `researchPack.sources` (verificado programáticamente, 0 inválidos).
- [x] Sin afirmaciones prohibidas (escaneo programático de alienígenas/Atlántida/civilizaciones perdidas/tecnología imposible/conspiraciones/"la ciencia no puede explicarlo" — 0 coincidencias).
- [x] Cero llamadas a APIs pagadas (ElevenLabs, OpenAI Images, Anthropic API, HeyGen) — confirmado, ninguna herramienta de red a esos proveedores se invocó en esta sesión.
- [x] Ningún fixture presentado como contenido real — este paquete reemplaza por completo el contenido fixture de Fase A; `isFixtureContent: false` en el JSON, y el propio guion lo declara.
- [x] Ningún asset generado todavía — no se descargó ni generó ninguna imagen/audio/video real ni fixture en esta fase; el storyboard son especificaciones, no ejecuciones.
- [x] Sin cambios innecesarios al pipeline 9:16 — ver informe de cambios de código abajo; el único código tocado es aditivo y nuevo (`script-loader.ts` + una bandera opcional en el orquestador), cero líneas modificadas en `generate-video.ts`, `VerticalReel.tsx` o cualquier archivo del pipeline Shorts.

## Riesgos pendientes para Fase B
1. **Coordenadas del mapa** (`b2-s1`) necesitan verificación contra fuente primaria antes de producción.
2. **Disponibilidad real de stock específico** en Pexels para los 17 shots `documentary_image` es una incógnita hasta ejecutar las búsquedas reales (que no se ejecutaron en esta fase).
3. **Costo de TTS real** puede variar ligeramente según el plan/tarifa exacta de tu cuenta de ElevenLabs (la estimación usa la tarifa pública configurada en el proyecto, $0.10/1k caracteres).
4. **Credenciales**: este entorno de sandbox sigue sin `ELEVENLABS_API_KEY`/`OPENAI_API_KEY`/`PEXELS_API_KEY`/service-role de Supabase — sigue siendo el mismo bloqueo técnico reportado en Fase A, no resuelto aquí.
