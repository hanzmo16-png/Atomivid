# ATOMIVID PRECAMPAIGN V2 — VFX-002 corrección final — REVIEW MASTER

**Estado: REVIEW MASTER + proxy listos para aprobación humana. No publicado. No sustituye el master aprobado anterior.**

Rutas en Storage:

| Asset | Ruta |
|---|---|
| REVIEW MASTER | `videos/precampaign-teaser-v1/output/ATOMIVID-precampaign-v2-REVIEW-vfx002b.mp4` |
| Composite VFX-002b | `videos/precampaign-teaser-v1/v2/vfx-002b-composite.mp4` (sha256 `a507cacb…`) |
| Master aprobado anterior | `videos/precampaign-teaser-v1/output/ATOMIVID-precampaign-v2-cinematic.mp4`, intacto |

Artefactos de CI:

- Master: run 37125015839, artefacto 11275455138.
- VFX-002b: run 37124665044, artefacto 11273679719.

## Qué se reutilizó / qué se reemplazó

| Elemento | Decisión |
|---|---|
| Hans (video real) | **Reutilizado.** Píxeles originales de la toma de apertura (ventana 4.7–9.7 s, look aprobado). |
| Matte | **Reutilizado.** Robust Video Matting (ONNX, CPU). Resolución interna subida a 0.4 para bordes más limpios. |
| Audio, voz, TTS persistido, avatar, música, subtítulos, cierre real de Hans | **Reutilizados.** Replay del ledger, 0 llamadas pagadas. |
| Montaje "resultados" (DULCE / Ocean) | **Reutilizado.** La placa de texto se reemplazó por la insignia de marca. |
| Plate NYC de Luma | **Reemplazado y no reutilizado.** Nuevo fondo: **video real** de Times Square de noche (Pexels 5908347, Katerina Holmes, licencia gratuita). Vertical nativo 2160×3840, cámara fija. |
| Transición (humo / anillo oscuro) | **Reemplazada** por un "render scan" de IA: línea en el acento real `#7c6aef` que sube detrás de Hans, con la habitación redibujada como render de bordes y la ciudad encendiéndose detrás. |
| Montaje de palabras "GUION / VOZ…" | **Reemplazado** por la **interfaz real de ATOMIVID** (ver abajo). |
| Revelación "CREATED WITH ATOMIVID" | **Reemplazada** por la **landing en producción** (atomivid.vercel.app) en un teléfono. |
| End card con texto blanco | **Reemplazado** por el cierre oficial (ver abajo). |

### Cierre oficial

- Logo real de `Logo.tsx` (tres órbitas + núcleo).
- Wordmark "Atomivid", tal como lo escribe la app.
- "Tu idea. Tu video."
- Píldora "Próximamente." con el estilo del badge "Beta pública" de la landing.
- Tokens de `globals.css` y fuente Geist.

## Interfaz real de ATOMIVID

- **Landing:** captura de **producción**.
- **Componentes del dashboard:** son los componentes reales del código desplegado (rama por defecto), renderizados con `next dev` en sus rutas internas de QA visual. Esto evita usar una cuenta o un login.
  - selector "¿Qué quieres crear?" → YouTube / Documental;
  - campo "Título principal";
  - "Confirmar y generar video";
  - tarjetas de progreso reales: En cola → Narrando el guion → Preparando imágenes y video por escena → Renderizando el documental;
  - resultado 16:9 dedicado.
- **Datos de demostración:**
  - El título que se escribe es el de una producción real de ATOMIVID: "DULCE: What Came Home".
  - El reproductor del resultado muestra **footage real de DULCE**.
  - Los metadatos se ajustaron a "Inglés · 600s".
- **Toques simulados:** los toques visibles (círculo de "tap") se añadieron en el montaje.

## Estructura

| Tramo | Contenido |
|---|---|
| A) 0–2.6 s | Hans original. |
| B) ~2.6–4.0 s | Transformación visible: render scan sobre la habitación. |
| C) hasta 7.2 s | Hans intacto + Times Square en movimiento. |
| D) | Avatar "Se llama ATOMIVID". En "Tú le das una idea…" entra la interfaz real: selector, título y Confirmar. Luego "Guion. Voz. Imágenes. Movimiento. Música. Subtítulos" sobre las tarjetas reales, y "Todo dentro del mismo proceso" sobre el resultado reproduciendo DULCE. |
| — | Resultados reales (DULCE / Ocean) con la insignia "Hecho con Atomivid". |
| — | "El video que estás viendo también fue creado con ATOMIVID" sobre la landing en producción. |
| — | Cierre real de Hans (CTA). |
| E) | End card oficial (2.0 s). |

## QA visual obligatorio

Frames de control: `QA-CONTACT-SHEET-REVIEW.jpg`:

- antes de la transformación;
- dos frames a mitad de transformación;
- NYC final;
- close-ups de pelo/lentes y manos/brazos;
- selector;
- título;
- En cola;
- imágenes;
- render;
- resultado con DULCE;
- insignia;
- dos frames de la landing de producción;
- end card.

| Check | Resultado |
|---|---|
| Hans permanece idéntico al source | ✅ En el interior del matte (162,2 M píxeles en 150 frames), la diferencia máxima vs source con grade es **2/255** (redondeo y light wrap del borde). La diferencia vs source sin grade es de 48/255, que es solo el grade/relight permitido. Prueba visual: `vfx-002-source-vs-composite.mp4`, con el panel de diferencia ×20 en negro sobre Hans. |
| Sin contaminación detrás de brazos/manos | ✅ Los huecos brazo/torso muestran la placa real oscura. |
| Sin halos evidentes | ✅ Se corrigieron dos defectos durante el QA: una mancha gris en el hombro izquierdo y pelo recortado por un refinamiento demasiado agresivo. Ver "Defectos restantes". |
| NYC inequívocamente reconocible | ✅ Times Square: pantallas gigantes y torre con rótulo H&M. |
| NYC con movimiento real | ✅ Es video real. Diferencia media entre frames de la placa: 2.31 (las pantallas cambian continuamente). |
| Sin pixelación evidente | ✅ La placa es 4K nativa reducida a 1080. Lleva un desenfoque ligero (σ 1.6), no una papilla. |
| Transformación intencional/premium | ✅ Render scan limpio en el color de marca. Sin humo, sin manchas, sin deformar al sujeto. |
| Aparece la interfaz REAL de ATOMIVID | ✅ |
| Branding y colores coinciden con producción | ✅ Comprobado contra capturas de atomivid.vercel.app: logo, `#7c6aef`, `#08080c` y Geist. |
| El resultado demuestra el producto | ✅ Idea → producción por etapas → video real terminado. |

### Checks automáticos del master

- Formato: 35.23 s, 1080×1920, 30 fps.
- Audio: −14.3 LUFS, true peak −1.5 dBTP.
- Desfase A/V máximo: 42 ms.
- Sin negros ni blancos accidentales.
- Subtítulos sin solapes.
- End card ≤ 2.5 s.
- **14/14 checks OK.**
- Sin salto en el empalme del composite (2.2 s).

### Calidad del matte

- Flicker en bordes estáticos: 0.031 (RVM crudo: 0.041).
- Ventana del composite: 5 s.

## Proveedores y costo

| Concepto | USD |
|---|---|
| VFX-002b (placa, matte, composite, transición) | **0.00** |
| Interfaz y branding (capturas locales y de producción, render del end card) | **0.00** |
| Master REVIEW (replay del ledger) | **0.00** (0 llamadas pagadas) |
| **Gasto real de esta corrección** | **USD 0.00** |
| Acumulado V2 (VFX-001 intento #3, ya gastado antes) | 1.08 |

- No se llamó a Luma, Runway, Veo, Kling ni OpenAI. No se repagaron HeyGen ni ElevenLabs.
- La placa se obtuvo con el catálogo gratuito de Pexels, sin pago.

## Defectos restantes (honestos)

1. **Sin taxis visibles.** La placa elegida muestra pantallas, torre y transeúntes, pero ningún taxi en la zona que Hans deja visible. Los taxis quedarían detrás de su torso.
2. **Marcas de terceros en el fondo.** Aparecen el rótulo H&M y anuncios en las pantallas de Times Square. Antes de usarlo en publicidad pagada conviene revisar derechos o derivar a una placa con menos marcas.
3. **Iluminación de Hans.** Hans sigue más iluminado que la noche ambiente. Es un grade más frío y oscuro, no un relight real: se lee como "luz de entrevista".
4. **Bordes difíciles:**
   - En el hombro izquierdo con desenfoque de movimiento, frente a una pantalla muy brillante, queda un escalonado leve, visible solo a 2–3×.
   - Las puntas del pelo sobre el cielo negro tienen un borde algo suave.
5. **Fixtures en la interfaz.** El dashboard se capturó del código desplegado con datos de demostración; producción requiere login. La fecha "1/1/2026" de la tarjeta de resultado es del fixture.
6. **Footage de DULCE.** Se ve en el reproductor con sus subtítulos en inglés quemados.
7. **Wordmark.** El end card usa "Atomivid", que es como lo escribe la app real, no "ATOMIVID" en mayúsculas.
8. **Avatar.** Ahora solo se ve unos 1.1 s ("Se llama ATOMIVID"). En "Tú le das una idea…" pasa a la interfaz real.

## Recomendación si se exige tráfico/taxis visibles

No hace falta gastar todavía. El scout gratuito encontró placas verticales 4K con taxis (Pexels 5834625, 5834632), pero tienen menos movimiento visible sobre la cabeza de Hans.

Si se quiere una placa a medida (Times Square + taxis cruzando a la altura de los hombros, cámara fija), la opción recomendada es **Runway (Veo 3.1 o Gen-4.5 vía su API), solo para el plate**. Hans seguiría bloqueado como ahora.

| Opción | Costo estimado |
|---|---|
| Veo 3.1, 6 s, 1080×1920, sin audio | ~USD 1.20 |
| Gen-4.5, 5 s, 720p | ~USD 0.60 |
| Tope propuesto | USD 2.50 |

Las tarifas no están verificadas: el sitio de documentación no fue accesible desde el sandbox.
