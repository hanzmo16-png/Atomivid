# Muestra M2 — apertura de «Cómo se construyó el Canal de Panamá»

Solicitud `2f35d750-8023-456d-810e-d805cba7859c`, beat 1 (0–48.576 s de la
narración GUARDADA; sin nueva síntesis) + 1.4 s de cola = **49.98 s**.
Salida y estado separados: `<requestId>/samples/m2-opening/` (el
`output/final.mp4` completado no se toca).

Herramientas (genéricas, no específicas de Panamá):

- `scripts/long-form-candidate-review.ts` + workflow `long-form-candidate-review.yml`:
  tiempos por palabra, miniaturas de lo ya guardado y búsquedas gratuitas
  (Pexels; Wikimedia Commons SOLO dominio público) con hojas de contacto en el
  log para revisión VISUAL.
- `sample-manifest.json`: escenas, recurso, procedencia, revisión, dirección y
  hoja de sonido. `validateSampleManifest` comprueba continuidad, que el
  fragmento declarado es lo que realmente se narra, cortes fuera de palabras,
  unicidad y revisión.
- `scripts/long-form-quality-sample.ts` + `long-form-quality-sample.yml`:
  PHASE=prepare (resolución, recorte, identidad de contenido, duración de clips
  y pistas) y PHASE=render (technical / approval, masterización, QC).

La hoja de escenas y la lista de pistas (con autor, licencia y página de cada
recurso) están en `SCENE_SHEET.md`, generada a partir del estado preparado.

## Criterios aplicados

- Cada escena = un pasaje narrado, con el corte llevado al silencio entre
  palabras (0.12 s antes de la palabra siguiente).
- Material moderno SOLO donde la narración habla del presente o invita a
  imaginar («Imagina…», «Hoy…»); el pasado se cuenta con fotografías de
  archivo auténticas (1896–1914, dominio público) con crédito en pantalla.
- Ninguna imagen de otro lugar presentada como Panamá: el trópico genérico
  (niebla, mosquito) no se rotula ni se afirma como Panamá; las vistas del
  canal actual son del Puente de las Américas y de Miraflores (verificadas).
- Sin tarjetas de título; el dato «80 km» va sobre un mapa de datos reales.
- Fundidos solo en saltos de época (ilustrativo→archivo, presente→pasado) y al
  cierre; el resto, cortes.
- Movimiento: los clips usan su propio movimiento (sin zoom añadido); las
  fotos, un movimiento lento que alterna (acercar, panear, alejar).

## Sonido

Solo pistas del banco con procedencia registrada (`src/lib/providers/music/manifest.ts`).
Elegidas por metadatos de tono, **no escuchadas**: la aprobación auditiva
queda pendiente (Hans). Faltan ambientes y efectos (ver `missingSound` del
manifiesto); no se sustituyeron por tonos de prueba.
