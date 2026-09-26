# Muestra M3 — apertura con movimiento (hook) para Panamá

Parte de la muestra M2 de 49.98 s, que ya fue aprobada en música, montaje y
dirección visual. Solo cambia la apertura: los primeros ~11 s son todos de
**movimiento real**. Después entran las fotografías históricas con movimiento
suave.

Salida y estado van separados en `<requestId>/samples/m3-hook/`. La muestra M2
y el `output/final.mp4` del documental no se tocan.

## Hook propuesto: 0–10.9 s

| Escena | Tiempo | Narración | Imagen | Tipo |
|---|---|---|---|---|
| s01 (H1) | 0–2.62 s | «Imagina cavar una montaña con picos y palas,» | Obreros con pico y pala en ladera de arcilla roja y selva, hacia 1885–1910 | **Clip IA nuevo** (imagen IA de época → Veo). Se usan 2.62 s de un clip de 8 s, desde 1.5 s |
| s02 | 2.62–5.54 s | «rodeado de mosquitos…» | Mosquito picando (Pexels) | Video real, sin cambios |
| s03 | 5.54–8.65 s | «en un calor húmedo que no da tregua.» | Selva con niebla (Pexels) | Video real, sin cambios |
| s04a (H2) | 8.65–10.9 s | «Así empezó, para miles de trabajadores,» | La foto de 1913 del corte Culebra (FMIB 38668) **animada**: vapor, obreros, avance lento | **Clip IA nuevo** (foto de archivo → Veo), fundido de 0.6 s desde s03 |
| s04b | 10.9–13.1 s | «la historia del Canal de Panamá.» | La **misma foto original**, fija con acercamiento lento | Archivo. Fundido de 0.8 s: el movimiento «se asienta» en el documento real |

A partir de s05 (13.1 s), todo es idéntico a M2: escenas, cortes, fundidos,
créditos y las tres pistas de música con los mismos tiempos.

## Rótulos y procedencia

- Los clips IA siempre llevan la procedencia `ai_recreation`, que se rotula
  **«Recreación IA»**. El validador rechaza un clip IA sin ese rótulo.
- s04a lleva además el crédito «Animación IA de una fotografía de 1913». s04b
  conserva «Archivo · Corte Culebra, 1913».
- Por cada clip se guarda `ai/<clave>.provenance.json` con:
  - proveedor, modelo, prompt y prompt negativo;
  - costo, `providerJobId` y fecha;
  - la referencia usada (página y licencia de Commons, o prompt, modelo y
    costo de la imagen IA).
- El audio que genera Veo se descarta: el clip se monta en silencio y el
  sonido sigue siendo la voz guardada más la música aprobada.

## Exactitud histórica (lo que piden los prompts)

- **H1:**
  - obreros afrocaribeños, que fueron la mayoría de la mano de obra tanto en
    la etapa francesa como en la estadounidense;
  - camisas de algodón y sombreros de paja o fieltro, picos y palas;
  - sin maquinaria, porque la narración habla de «picos y palas»;
  - excluidos: casco, chaleco reflectante, botas de goma, gorras, estampados,
    relojes y tendidos eléctricos.
  - Las imágenes IA existentes del documental se rechazaron como referencia
    (gorras de béisbol, botas de goma, camisetas modernas; palas de vapor
    sobre orugas cuando las de Panamá iban sobre rieles).
- **H2:**
  - conservar blanco y negro, grano y composición;
  - no añadir personas ni máquinas; solo vapor, obreros trabajando y un
    avance muy lento.
  - La referencia es un recorte 16:9 de la misma foto de dominio público de
    M2 (x 0.03–0.66, y 0.32–0.845), que excluye el retrato de L. K. Rourke.

## Presupuesto (pendiente de aprobación)

| Concepto | Proveedor | Unidades | Costo |
|---|---|---|---|
| Imagen de referencia H1 | OpenAI Images (1536×1024, recortada a 16:9) | 1 | $0.06 (reserva; costo real observado ≈ $0.055) |
| Clip H1 | Veo 3.1 Fast, 1080p, 8 s, $0.12/s | 1 | $0.96 |
| Clip H2 | Veo 3.1 Fast, 1080p, 8 s, $0.12/s | 1 | $0.96 |
| **Esperado** | | | **$1.98** |
| Tope solicitado (permite 1 reintento de la imagen y de cada clip) | | | **$4.00** |

Los reintentos nunca son automáticos. Un reintento usa una clave nueva
(`…-v2`) en el manifiesto y requiere revisar el primer resultado. El libro
`state/paid-ledger.json` reserva cada gasto **antes** de la llamada y no
permite pasar del presupuesto aprobado, que se acumula entre ejecuciones.

## Cómo se ejecuta

- **Sin autorización** (por defecto):
  - PHASE=prepare monta los sustitutos gratuitos: la foto de stock actual en
    s01 y la foto de archivo en s04a.
  - Cada sustituto conserva su procedencia **real** (nunca «Recreación IA»
    sobre una foto de stock) y queda marcado como pendiente, así que el
    render de aprobación se bloquea.
- **Con aprobación**:
  - `allow_paid=true` y `paid_budget_usd=<monto aprobado>` en PHASE=prepare.
  - Solo entonces el workflow recibe las claves de OpenAI y Veo.
  - Un clip ya generado se reutiliza siempre sin costo. Una operación ya
    enviada se reanuda, nunca se reenvía (`wrapDurableVideoProvider`).

## Comparación A/B

Las dos aperturas se renderizan en la misma ventana de 0–20.6 s (fin de la
frase «…para siempre.»), con la misma voz y la misma música:

- **A (apertura actual):** manifiesto M2, `purpose=approval`,
  `window_sec=20.6` → `samples/m2-opening/sample-approval-21s.mp4`.
- **B (apertura con video IA):** este manifiesto, generado tras la
  aprobación → `samples/m3-hook/sample-approval-21s.mp4`.

La vista previa técnica gratuita, con sustitutos, sale en
`samples/m3-hook/sample-technical-21s.mp4`.

## El video IA no es obligatorio en V3

El clip IA es una fuente **por escena** (`veo-clip`) que un manifiesto declara
explícitamente. Sin ella no hay gasto: la muestra M2 tiene un plan de gasto
vacío, y hay un test que lo comprueba. En producción, el video IA sigue
limitado por la asignación existente (`maxAiVideoClips`,
`isLongFormAiVideoConfigured`).

## Vista previa gratuita (sin gasto)

- **A** — apertura actual: `samples/m2-opening/sample-approval-21s.mp4`, run 36204032458.
  - Resultado: −15.95 LUFS, **−2.47 dBTP**, 0 tramos negros.
- **B** — montaje del hook con sustitutos: `samples/m3-hook/sample-technical-21s.mp4`, run 36204420906.
  - Resultado: −15.95 LUFS, −2.47 dBTP, 0 tramos negros.
  - «Material pendiente» aparece en s01 y s04a.
  - Los subtítulos no cruzan cortes.
  - La referencia 16:9 de H2 se revisó en la hoja de preparación (run 36204030936). Conserva la pala de vapor, la cuadrilla y los rieles.

El pico real de −1.21 dBTP de M2 queda corregido por el margen de
masterización (`LONG_FORM_TRUE_PEAK_MARGIN_DB`).

**Limitación:** en B, el sustituto de s04a hereda el encuadre `cover` del
clip IA, por lo que la foto aparece recortada. El clip real ya es 16:9, así
que en el render aprobado esto no ocurre.

## Ejecución autorizada (tope $4.00, incluidos todos los intentos)

| Fecha (UTC) | Clave | Resultado | Costo real |
|---|---|---|---|
| 2026-09-26 00:31 | `m3-h1-picks-v1:still` (OpenAI Images, 1536×1024, calidad media) | Generada y guardada en `samples/m3-hook/ai/m3-h1-picks-v1-still.png`. Metadatos en `-still.json` | **$0.0558** (192 tokens de entrada y 1372 de salida) |
| 2026-09-26 00:31 | `m3-h1-picks-v1:veo` | **No enviada.** `VEO_API_KEY` no existe como secreto de GitHub Actions: solo está en Vercel, donde corrió P2B. Reserva liberada de forma verificada (sin id de operación ni registro durable) | $0.00 |

- **Comprometido:** $0.0558 de $4.00.
- **Revisión de la imagen (run 36205569162, hoja de preparación):**
  - Aceptada **sin reintento**.
  - Muestra tres obreros afrocaribeños con camisa de algodón clara y sombrero de paja o fieltro, con pico y pala en una ladera de arcilla rojiza; selva y bruma detrás.
  - Sin casco, chaleco, gorra, botas de goma ni maquinaria.
  - El recorte a 16:9 conserva a los tres obreros y las herramientas.
- **Bloqueo:** para generar los dos clips, el repositorio necesita el secreto de Actions `VEO_API_KEY`, con el mismo valor que en Vercel.
  - Esto afecta también al worker de producción: `render.yml` (Long Form) lee el mismo secreto. Hoy, un clip Veo de producción que se ejecute en GitHub Actions caería al respaldo.

## Generación de los clips (2026-09-26, tras añadir `VEO_API_KEY` a Actions)

1. **Verificación gratuita** (run 36209435502, `paid_preflight_only`):
   - el workflow recibe las dos claves;
   - Google responde **200** a la lectura de metadatos de `veo-3.1-fast-generate-preview`;
   - no hace falta OpenAI (la imagen de época se reutiliza).
2. **Generación** (run 36209546007):
   - dos clips de 8 s a 1080p;
   - operaciones `…/operations/sf12ueidl2de` y `…/operations/zx4hzluvsemf`;
   - procedencia guardada en `ai/<clave>.provenance.json`.
3. **Revisión** (run 36209958820, fotogramas de 640 px):
   - **H1:** aceptado sin reintento.
   - **H2:** aceptado sin reintento, con desviaciones (ver la nota de s04a en el manifiesto):
     - una forma oscura de la foto se convierte en locomotora;
     - el vapor cambia de forma;
     - el encuadre sube levemente.
   - Un reintento de H2 costaría $0.96 (clave `m3-h2-culebra-v2`) y **solo se hará si Hans lo pide**.
4. **Render B** (run 36210113940): `samples/m3-hook/sample-approval-21s.mp4`.
   - Resultado: −15.95 LUFS, −2.47 dBTP, 0 tramos negros.
   - Los rótulos «Recreación IA» aparecen en s01 y s04a.
   - Los subtítulos no cruzan cortes.
   - «approval» es el modo de render sin marcas de pendiente. **No** equivale a la aprobación de Hans.

### Costo real

| Recurso | Proveedor | Costo |
|---|---|---|
| Imagen de época (H1) | OpenAI Images, calculado desde `usage` | $0.0558 |
| Clip H1 | Veo 3.1 Fast, 8 s × $0.12/s | $0.96 |
| Clip H2 | Veo 3.1 Fast, 8 s × $0.12/s | $0.96 |
| Reserva liberada (Veo, nunca enviada) | — | $0.00 |
| **Total** | | **$1.9758 de $4.00** |

El costo de Veo es la tarifa publicada multiplicada por la duración: la API no
devuelve el importe de cada llamada. La factura de Google es la fuente definitiva.

## Versión final (dirección aprobada por Hans: B)

- **Sin reintentos pagados.** La transición H2 → foto original se ajustó solo con recursos existentes:
  - s04b usa la misma fotografía FMIB 38668, recortada a 16:9 (x 0.019–0.592, y 0.303–0.780) con el encuadre al que llega el clip al final de su acercamiento, a pantalla completa y sin bandas difuminadas;
  - mantiene el acercamiento lento, que continúa el del clip;
  - el fundido pasa de 0.8 s a 1.0 s;
  - en el render la pala «230» queda casi en la misma posición y escala a ambos lados del fundido;
  - la foto se ve algo más blanda: es un recorte ampliado de un fotograbado de 1913.
- La voz, la música, los subtítulos, los créditos y el montaje desde s05 no cambian (idénticos a M2).
- **Muestra completa** (render de aprobación, 49.98 s), `samples/m3-hook/sample-approval.mp4`:
  - −15.69 LUFS, **−2.41 dBTP**, LRA 1.8;
  - 0 tramos negros;
  - pausas solo con música entre −23 y −33 LUFS momentáneos.
- El workflow publica ahora el MP4 como descarga directa (`upload-artifact@v7`, `archive: false`), además del ZIP con los informes.
- **Costo total de la Misión 3:** $1.9758 (imagen $0.0558 + 2 clips Veo × $0.96). Ninguna llamada de pago después de la aprobación de B.

## Fotograma inicial (t = 0 s)

Captura: `first-frame.jpg`, y cómo se ve en celular: `first-frame-phone.jpg`.

- **Hecho del relato:** obreros cavando con pico y pala, que es lo que narra la voz («Imagina cavar una montaña con picos y palas»). Mantiene el rótulo «Recreación IA».
- **Sujeto principal:** el clip arranca en su fotograma 0, con el obrero del pico en alto justo antes del golpe. Es la pose de máxima tensión y enseguida viene el golpe.
- **Composición:** reencuadre fijo de 1.30× anclado arriba a la izquierda.
  - El obrero del pico ocupa el tercio izquierdo con una diagonal fuerte; el segundo obrero queda en el tercio derecho.
  - La cara es reconocible a tamaño de celular.
  - El pico queda dentro del cuadro.
- **Gradación:** contraste 1.15, saturación 1.10 y viñeta 0.45. Es un ajuste opcional por escena (`SceneDirection.look`); las demás escenas no cambian.
- **Sin texto añadido:** en t = 0 todavía no hay subtítulo; el primero aparece con la primera palabra.
- **Nitidez:** el reencuadre amplía un clip de 1080p, así que el fotograma pierde algo de nitidez (visible en la captura a tamaño completo).
- **Render** (run 36213646814):
  - −15.69 LUFS, −2.41 dBTP, 0 tramos negros;
  - el montaje desde 2.62 s es idéntico al anterior.
- Sin gasto nuevo.
