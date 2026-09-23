# Göbekli Tepe — Plan de producción v.003 (actualización 2026)

**videoId:** gobekli-tepe-001
**scriptRef:** `gobekli-script-003-current.json`
**storyboardRef:** `gobekli-storyboard-003.json`
**Estado:** preproducción — pendiente de aprobación del usuario y del checkpoint visual (VISUAL TEST V2)

## 1. Qué contiene este checkpoint

Este es el tercer ciclo de preproducción del video #001 (Göbekli Tepe). No reemplaza ni borra ningún archivo anterior:

- `gobekli-script-002-final.{md,json}` — v.002, aprobada con ajustes, se conserva intacta.
- `gobekli-storyboard-001.json` — 44 shots, 0 IA, se conserva intacta.
- `gobekli-storyboard-002-hybrid.json` — reclasificación híbrida-premium, se conserva intacta.
- `gobekli-visual-test-001.md` — 3 prompts de prueba visual, se conserva intacta (imágenes aún no generadas: falta `OPENAI_API_KEY`).
- **Nuevo en este checkpoint:** `research-pack-002.json`, `gobekli-script-003-current.{md,json}`, `gobekli-storyboard-003.json`, este plan, y `atomivid-long-form-visual-bible-v1.md`.

## 2. Resumen de la investigación 2026

Ver `research-pack-002.json` para el detalle completo. En síntesis:

| Hallazgo | Certeza | Uso en el guion |
|---|---|---|
| DAI describe el sitio como "asentamiento con fuerte componente ritual" | ESTABLISHED | beat-2/beat-7 (contexto), consistente con v.002 |
| Nuevas estructuras rectangulares 2026, evaluadas como posiblemente residenciales (Karul, ~1.500 m², al norte del núcleo) | RECENT_FINDING | beat-1 (hook), beat-8 (detalle) |
| Paper de Gresky/Clare sobre restos humanos/enterramientos, septiembre 2026 | **OPEN_QUESTION — NO VERIFICADO** | beat-10 (declarado explícitamente como no verificado, no usado como evidencia) |
| Göbekli Tepe como parte de la red Taş Tepeler / Karahan Tepe | ESTABLISHED | beat-9 |
| Coordenadas exactas del sitio | **OPEN_QUESTION — pendiente de fuente primaria** | b2-s1 del storyboard, precisión reducida mantenida |

**Limitación metodológica declarada:** el proxy de salida de red de este entorno bloqueó (`EGRESS_BLOCKED`) el acceso directo (`WebFetch`) a whc.unesco.org, en.wikipedia.org, wikidata.org, dainst.org, dainst.blog, mdpi.com, hurriyetdailynews.com, arkeonews.net, ancient-origins.net, dailysabah.com, researchgate.net, aa.com.tr, arkeofili.com, theothertour.com, popular-archaeology.com y thearchaeologist.org. Toda la investigación de este checkpoint se basa en resúmenes agregados de `WebSearch`, nunca en lectura directa del texto completo de la fuente primaria. Esto se declara explícitamente en `research-pack-002.json` y en el propio guion (beat-10).

## 3. Decisión de tesis (resumen — ver detalle en el guion, sección 1)

Se descartó la versión dramática ("LA HISTORIA... ESTÁ CAMBIANDO" como reversión total) porque su pieza de evidencia más fuerte —el supuesto paper de Gresky/Clare 2026— no se pudo verificar. Se adoptó una tesis moderada y evidence-driven: *Göbekli Tepe sigue obligando a corregir, temporada tras temporada, la imagen que teníamos de él.* El hook abre con el hallazgo/corrección de 2026, no con la escena de paisaje.

## 4. Storyboard v.003 — resumen

- **45 shots** (dentro del rango objetivo 35-55), 13 beats.
- Distribución híbrida: TEXT 17 · AI_RECREATION 11 · DETERMINISTIC 9 · REAL_DOCUMENTARY 5 · STOCK_REAL 3.
- Misma disciplina que v.002: ninguna evidencia arqueológica específica (pilares, relieves, estructuras, restos humanos, geografía) se resuelve con IA. AI_RECREATION se reserva para atmósfera, recreaciones humanas explícitamente no documentales, y síntesis conceptual.
- **Regla nueva explícita:** ningún shot que involucre restos humanos identificables (b10-s2, cráneo modificado) puede ser `AI_RECREATION` — se marcó `REAL_DOCUMENTARY` con `hybridReason` explicando la prohibición.
- Los shots del hallazgo 2026 condicional (b8-s5) llevan una nota explícita: la recreación visual debe ir siempre acompañada del hedge textual/narrado (b8-s4), nunca sola.

### 4.1 Registro de derechos/licencia (ledger)

Cada shot `REAL_DOCUMENTARY` o `STOCK_REAL` incluye un objeto `licensing` en el JSON. Resumen:

| Estado | Cantidad | Significado |
|---|---|---|
| `CLEARED` | 3 shots | Fuente de clase Pexels — licencia comercial segura, sin atribución requerida, resolución del archivo específico por query en tiempo de render (mismo patrón que el código real ya implementado en `src/lib/providers/footage/`) |
| `NEEDS_REVIEW` | 5 shots | Evidencia arqueológica o de restos humanos muy específica del sitio — un banco de stock genérico no tiene material preciso; requiere selección manual de una fuente verificable (p. ej. Wikimedia Commons con licencia CC confirmada individualmente, o material de prensa del DAI con permiso explícito) antes de producción real. Ninguno de estos 5 shots tiene todavía un archivo específico asignado — cero riesgo de infracción porque no se ha descargado ni usado nada. |
| `NOT_CLEARED` | 0 shots | No aplica en este checkpoint — no se identificó ninguna fuente con licencia conocida-y-prohibida. |

**Nota importante:** el ledger es de preproducción. Ningún asset ha sido descargado, generado ni pagado en este checkpoint. Antes de una producción real, los 5 shots `NEEDS_REVIEW` requieren una pasada de selección manual de fuente (no automatizable de forma segura, porque implica juicio sobre licencias específicas de archivos individuales).

## 5. Modelo de costos (actualizado para v.003)

Basado en las constantes reales ya configuradas en el código (`PRICING_ELEVENLABS_USD_PER_1K_CHARS = $0.10`, `ESTIMATED_COST_USD = $0.05` por imagen OpenAI en calidad `medium`, `LONG_FORM_MAX_TOTAL_USD = $12` como techo ya configurado):

| Partida | Cálculo | Costo estimado |
|---|---|---|
| TTS (ElevenLabs) | 11,629 caracteres / 1,000 × $0.10 | **$1.163** |
| Imágenes IA (`AI_RECREATION`, calidad medium) | 11 shots × $0.05 | **$0.55** |
| Imágenes IA (`AI_RECREATION`, calidad high, estimado ~1.8-2.2×) | 11 shots × ~$0.09–0.11 | ~$0.99–1.21 |
| Footage/imágenes reales (Pexels) | 3 `CLEARED` + 5 `NEEDS_REVIEW` (pendientes de fuente) | $0 (API gratuita / selección manual) |
| Música (curated-library) | — | $0 |
| Render (Remotion, cómputo local/CI) | — | $0 (no es una API de pago por unidad) |
| **Total proyectado (calidad medium)** | | **≈ $1.71** |
| **Total proyectado (calidad high)** | | **≈ $2.15–2.37** |

Ambos escenarios quedan muy por debajo del techo ya configurado de $12 y del presupuesto de $0.50 autorizado específicamente para la prueba visual de 3 imágenes (ver sección 6). **Cero llamadas pagadas se hicieron en este checkpoint** — todo lo anterior es proyección, no gasto real.

## 6. Próximo paso — checkpoint visual (fuera de alcance de este mensaje)

Por instrucción explícita del usuario, este checkpoint NO genera imágenes IA ni llama ninguna API paga. El siguiente paso acordado es: **VISUAL TEST V2 → 3 imágenes IA de prueba → aprobación visual del usuario → Fase B completa.** El bloqueo técnico conocido sigue vigente: `OPENAI_API_KEY` no está configurada en este entorno (verificado repetidamente en `.env.local` y `process.env`); no se ha intentado resolverlo ni se ha pedido ninguna clave, según instrucción explícita.

## 7. Validación de este checkpoint

- [x] `research-pack-002.json` es JSON válido y conserva las 3 fuentes originales de research-pack-001.
- [x] `gobekli-script-003-current.json` valida contra el schema real de `script-loader.ts` (`ScriptFileSchema`) — probado con `loadScriptFromFile()` real, 13 beats, 1,847 palabras.
- [x] `gobekli-storyboard-003.json` es JSON válido, 45 shots (dentro de 35-55), sin campos `licensing` faltantes en shots `REAL_DOCUMENTARY`/`STOCK_REAL`.
- [x] Ningún claim del bloque 2026 convierte un hedge ("podrían ser", "evaluadas como") en afirmación categórica ("eran", "fueron confirmadas").
- [x] El supuesto paper de Gresky/Clare de septiembre 2026 se declara explícitamente como no verificado, tanto en `research-pack-002.json` como en el guion (beat-10) — no se usa como fuente de ningún claim.
- [x] Las coordenadas de precisión de arcosegundo propuestas por el usuario NO se adoptaron automáticamente; se documentó el intento de verificación y su resultado (bloqueado por egress, convergencia parcial de fuentes secundarias) y se mantuvo la precisión reducida ya usada en v.002.
- [x] Archivos anteriores (`-001`, `-002-hybrid`, `gobekli-visual-test-001.md`) permanecen sin modificar.
- [x] Cero llamadas a APIs pagas (Anthropic, OpenAI, ElevenLabs) en este checkpoint.
- [ ] Suite de tests completa y typecheck — pendiente de ejecutar antes del commit (ver reporte final).

## 8. Riesgos conocidos

1. **Dependencia de fuentes secundarias para casi todo el contenido 2026.** Ninguna fuente primaria pudo leerse directamente (egress bloqueado). Si el usuario tiene acceso directo a las fuentes primarias (DAI, prensa académica), una revisión humana antes de producción real es altamente recomendable.
2. **5 shots `NEEDS_REVIEW` sin fuente de licencia asignada**, incluido el shot más sensible (cráneo modificado, b10-s2) — bloquean producción real hasta selección manual.
3. **La premisa original del usuario sobre el paper de Gresky/Clare no se pudo confirmar** — si el usuario tiene la cita exacta (autores, revista, DOI, fecha), debe compartirla para una revisión dirigida; hasta entonces, el guion no la usa.
4. **Duración de ~11 min es una estimación de guion, no de render real** — el TTS real (ElevenLabs) puede variar ±10-15% frente a la estimación por palabras.
5. **Las coordenadas siguen sin verificación primaria** — si se necesita mayor precisión para un mapa más cercano/zoom, se requiere acceso directo a whc.unesco.org o a los datos GIS oficiales del sitio.
