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
