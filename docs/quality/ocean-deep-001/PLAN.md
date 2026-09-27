# «The Deep Ocean: What We've Seen—and What We Still Don't Know» — plan de producción

Estado: **preparado, no producido.** No se hizo ninguna llamada de pago, no se agregó ninguna voz a la cuenta, no se registró ningún workflow y no se tocó producción.

Los presupuestos de las pruebas medievales no se aplican a este documental. Producir requiere una autorización nueva con los topes A y B (sección 8).

| Pieza | Archivo |
|---|---|
| Guion (JSON validado por `loadScriptFromFile`) | `content/long-form/ocean-deep-001/ocean-script-001.json` (lo genera `build_script.py`) |
| Guion legible con referencias por sección | `docs/quality/ocean-deep-001/SCRIPT.md` |
| Storyboard (64 planos, costo y licencia por plano) | `content/long-form/ocean-deep-001/ocean-storyboard-001.json` |
| Primer minuto (borrador de manifiesto) | `docs/quality/ocean-deep-001/minute1-manifest.draft.json` |
| Búsquedas gratuitas por plano | `docs/quality/ocean-deep-001/search-spec.json` |
| Narración (única síntesis, caché durable) | `scripts/long-form-narrate.ts` |
| Workflow (sin registrar) | `.github/workflows/long-form-ocean.yml` |
| Pruebas | `src/lib/video/long-form/ocean-prep.test.ts`, `remotion/long-form-direction.test.ts` (bucle de música) |
| Hoja de fotogramas del ensayo | `docs/quality/ocean-deep-001/rehearsal-contact.png` |

## 1. Objetivo y pregunta

- Formato: YouTube, 1920×1080, unos 10 minutos. La duración sale del ritmo natural de la voz. No se estira ni se acelera para llegar a 10:00 exactos.
- Pregunta: ¿cómo sabemos qué hay en el océano profundo, y qué diferencia hay entre tener un mapa de un lugar y haberlo observado?
- El texto se escribió directamente en inglés a partir de fuentes independientes. No traduce ni parafrasea a RealLifeLore ni a ningún otro guion existente.
- Tono: documental sobrio. Sin monstruos, sin «más misterioso que el espacio» y sin cifras infladas.

## 2. Investigación y disciplina de métricas

Se manejan **tres magnitudes** y no se convierte ninguna en otra.

| Magnitud | Cifra usada | Fuente y fecha |
|---|---|---|
| Fondo **cartografiado** (área con sonar al estándar GEBCO) | 28,7 % (unos 104 millones de km²), casi 5 millones de km² en un año | Seabed 2030, 20-04-2026; página actual de NOAA |
| Fondo **observado** (área vista con cámara u ojos) | unos 3.823 km², ≈0,001 % del fondo profundo (un área del tamaño de Rhode Island) | Bell et al. 2025, *Science Advances*, doi:10.1126/sciadv.adp8602 |
| **Volumen** oceánico | el océano profundo (>200 m) es más del 90 % del volumen | NOAA Ocean Exploration |

- **Qué significa «cartografiado» en GEBCO:** basta un sondeo por celda. Las celdas miden 100, 200, 400 u 800 m según la profundidad. El guion lo dice para no vender el mapa como una fotografía.
- **Cifra descartada:** la página archivada de NOAA (enero de 2025) decía «>80 % sin cartografiar». Está superada y no se usa. Una prueba lo impide.
- **Sesgo de las observaciones** (Bell 2025): el 65 % de las observaciones está a menos de 200 millas náuticas de EE. UU., Japón y Nueva Zelanda. Solo el 19,1 % de las inmersiones fue en alta mar.
- **Otras cifras y su fuente:**
  - bioluminiscencia: el 76 % de los animales observados (Martini & Haddock 2017, 240 inmersiones frente a Monterey; el guion aclara que es un resultado **regional**);
  - especies nuevas: 1.121 en un año, algunas de más de 6.000 m (Ocean Census, abril de 2025 a marzo de 2026);
  - Challenger Deep: 10.935 ± 6 m (Greenaway 2021; otras mediciones difieren en decenas de metros);
  - Trieste llegó al fondo en 1960;
  - Deep Discoverer está preparado para 6.000 m;
  - SWOT resuelve relieves de unos 8 km;
  - la presión sube unos 1 atm cada 10 m.
- **Límite de verificación:** el proxy de este entorno bloqueó la descarga directa de varias páginas (NOAA, Seabed 2030, MBARI). Esas cifras se confirmaron por búsqueda con al menos una segunda fuente que cubre el mismo anuncio. Cada fuente lo anota en `researchPack.sources[].notes`.

## 3. Guion (1.398 palabras, 7.945 caracteres)

Estructura: una apertura (b1) y seis secciones narrativas (b2 a b7; la b7 es el cierre). El texto completo, con **hechos**, **incertidumbres declaradas**, **inferencias de encuadre**, **recreaciones IA** y las referencias de cada sección, está en `SCRIPT.md`.

| Beat | Sección | Palabras | Qué establece |
|---|---|---|---|
| b1 | Opening — a light in the dark | 128 | Una luz a 3.000 m muestra un trozo de fondo; «cartografiado» y «visto» son dos formas de saber |
| b2 | Three different measurements | 134 | Área cartografiada, área vista y volumen: tres números no intercambiables |
| b3 | What a map reveals — and what it does not | 288 | Ecosonda multihaz, satélites (gravedad, SWOT), 28,7 %, qué cuenta como celda cartografiada |
| b4 | Why seeing is so hard | 316 | Luz y presión, ROV y telepresencia, 0,001 % visto, sesgo geográfico, estimación con registros incompletos |
| b5 | Life and light in the dark | 215 | 76 % bioluminiscente (regional), luz azul, peces dragón de luz roja, nieve marina |
| b6 | What researchers are still looking for | 180 | 1.121 especies nuevas, incertidumbre del total, mapas que señalan objetivos, Challenger Deep ±6 m |
| b7 | Closing — a map and a visit | 137 | Un mapa no es una visita: «one lit patch at a time» |

**Pronunciación.** El inglés se lee con `eleven_multilingual_v2`.
- Todas las cifras van escritas como se dicen: «twenty-eight point seven percent», «ten thousand nine hundred and thirty-five metres», «nineteen sixty». Así el modelo no tiene que interpretar dígitos, porcentajes ni «±».
- El guion no usa siglas: no aparecen «ROV», «GEBCO», «SWOT» ni «hadal». Se dice «remotely operated vehicle», «the newest satellite data» y similares.
- Términos a escuchar en la primera toma: *multibeam*, *sonar*, *seamount*, *dragonfish*, *Deep Discoverer*, *Seabed twenty thirty*, *U.S.*, *Monterey*, *Rhode Island*, *Challenger Deep*, *nautical miles*.
- Si alguno sale mal, se corrige **solo ese beat**: se cambia la grafía en el guion y se vuelve a narrar ese beat, que es una clave nueva de la caché. El gasto sale del margen de recuperación.

## 4. Voz

Restricciones: no se usa «Hans podcast» ni su grabación; la voz clonada «Atomivid» (Hans) queda excluida; Mateo no se elige de forma automática; no se generan audios de pago ni se agregan voces.

| Voz | En la cuenta | Muestra pública (preview oficial de ElevenLabs) | Duración · loudness · F0 medido | Valoración |
|---|---|---|---|---|
| **Brian** `nPczCjzI2devNBz1zQrb` | sí (premade) | [preview](https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/2dd3e72c-4fd3-42f1-93ea-abc5d4e5aa1d.mp3) | 5,4 s · −24,7 LUFS · 95 Hz | **Propuesta.** Inglés nativo (EE. UU.), grave y tranquilo; encaja con un documental sobrio de 10 min |
| Bill `pqHfZKP75CvOlQylNhV4` | sí | [preview](https://storage.googleapis.com/eleven-public-prod/premade/voices/pqHfZKP75CvOlQylNhV4/d782b3ff-84ba-4029-848c-acf01285524d.mp3) | 5,5 s · −24,2 LUFS · 137 Hz | Alternativa 1: más madura y documental, menos grave |
| Daniel `onwK4e9ZLuTAKqWW03F9` | sí | [preview](https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3) | 5,7 s · −21,5 LUFS · 137 Hz | Alternativa 2: británica, tono de noticiario |
| George `JBFqnCBsd6RMkjVDRZzb` | sí | [preview](https://storage.googleapis.com/eleven-public-prod/premade/voices/JBFqnCBsd6RMkjVDRZzb/e6206d1a-0721-4787-aafb-06a6e705cac5.mp3) | 3,4 s · −23,0 LUFS · 151 Hz | Cálida, más de narrador de cuentos |
| Mauricio `94zOad0g7T7K4oa7zhDq` | **no** (en la Voice Library) | [preview EN](https://storage.googleapis.com/eleven-public-prod/database/user/aMFLZudGpbVyEMAcpCuGoohryKG2/voices/94zOad0g7T7K4oa7zhDq/eac9b7a2-675c-41a5-90e2-24c8bbee49d5.mp3) | 2,4 s · −14,5 LUFS · 129 Hz | **No se recomienda como principal** (ver abajo) |

Por qué Mauricio no:
- Habría que **agregarlo** a My Voices, lo que ahora no está permitido.
- Su etiqueta es de acento latinoamericano.
- La única muestra pública en inglés dura 2,4 s. No basta para juzgar 10 minutos de narración en inglés.

Si Hans lo prefiere, se agrega a la cuenta y se hace una toma de b1 dentro del tope A, sin ningún otro cambio.

- Las mediciones de duración, loudness y F0 salen de analizar los archivos. **No son una escucha.** Hans debe escuchar las muestras.
- **Modelo:** `eleven_multilingual_v2`, el mismo contrato estable que usa el producto, con hasta 10.000 caracteres por petición; el beat más largo tiene 1.843.
- `eleven_v3` no se propone: su prosodia varía más entre peticiones y aquí hay 7 beats que deben sonar como una sola toma.
- La voz se fija de forma explícita con `NARRATE_VOICE_ID` y la variable `ELEVENLABS_VOICE_ID_EN`. El script verifica que el proveedor use esa voz y ninguna otra.

**Saldo de ElevenLabs** (consulta de solo lectura en esta preparación):
- plan Starter, 23.570 de 38.002 caracteres usados, quedan **14.432**; no admite excedente (`can_extend=false`);
- el episodio usa 7.945 caracteres y deja 6.487; con una retoma de hasta 1.150 caracteres quedan 5.337, por encima de la reserva de 3.000 que exige el script.
- El paso `narrate-plan` vuelve a leer el saldo antes de cualquier síntesis.
- El plan de ElevenLabs no se cambia.

## 5. Música y silencios

- Se usan **fondos propios** del repositorio (`src/lib/tts/music-beds.ts`), sintetizados por código de forma determinista, sin material de terceros y con `attribution: null`.
  - Principal: `atomivid-suspense-a-v1` «Niebla baja»: ambiente grave, tensión moderada, sin percusión.
  - Para b5 y b6 (asombro): `atomivid-documentary-b-v1` «Horizonte».
- **Procedencia y licencia:** código propio de Atomivid. No se paga ninguna pista.
- Se excluyen:
  - las pistas de Eleven Music, porque los términos de algunos planes restringen ciertos usos comerciales;
  - las pistas de Pixabay del catálogo, porque son motivacionales o enérgicas.
- **Límite honesto:** que la música sea de producción propia no equivale a una garantía legal. Tampoco protege contra una coincidencia accidental de Content ID, que es improbable en un drone sintetizado.
- **Mezcla:**
  - `soundCues` en bucle con fundidos y ganancia de 0,8;
  - bajada automática bajo la voz (`narrationGaps`);
  - masterización de loudness del pipeline.
- **Silencios deliberados** (se fijarán como tramos sin música en el manifiesto del episodio, con los tiempos reales):
  - 1,5 s tras «roughly one thousandth of one percent of the deep seafloor» (b4);
  - la entrada de «Life and light in the dark» (b5) comienza en silencio y la música entra con la primera luz;
  - el final de b7 se funde a negro sin música.
- **Hallazgo del ensayo, corregido:** el `loop` del reproductor de audio de Remotion no repetía el fondo. La música sonaba de 0 a 48 s (la duración del bucle) y luego callaba. Medido quitando el tono de prueba: −31 dB hasta el segundo 48 y −51 dB después, que es el piso sin música.
  - Esto también habría afectado al primer minuto (unos 51 s) y al episodio.
  - Corrección aditiva: `expandLoopingCues` en `remotion/long-form-direction.ts` reparte una cue en bucle de duración conocida en tramos consecutivos sin bucle, con fundidos solo en los extremos y volumen continuo en la unión.
  - La CLI y la herramienta de muestras pasan la duración de la fuente.
  - Tiene prueba unitaria y se verificó en el segundo ensayo (sección 9.1).
- El sonido de sonar o ROV no se sintetiza: no hay fuente libre verificada. Queda en `missingSound` y se decide en la revisión.

## 6. Plan visual (storyboard)

Son 64 planos. Cada uno lleva duración aproximada, fuente o método, costo, licencia y si es IA. Suman unos 559 s estimados; el montaje final se corta a los tiempos reales por palabra.

| Tipo | Planos | Método | Costo |
|---|---|---|---|
| Tarjetas de cifra o cita (texto grande con la fuente en la tarjeta) | 18 |
| Diagramas secuenciales (zonas de profundidad, sonar, altimetría, presión, luz, «one lit patch») | 6 | Código de Atomivid, sin material de terceros | $0 |
| Mapas | 5 | Costas reales de Natural Earth (dominio público) y contorno de Rhode Island del U.S. Census Bureau (dominio público), dibujados por código con proporción real y la fuente en el mapa | $0 |
| Imagen (21) o vídeo (2) documental real | 23 | NOAA Ocean Exploration y Commons **solo de dominio público**; NASA/JPL con crédito, según sus normas | $0 |
| Vídeo de stock | 5 | Pexels (licencia Pexels; sin logotipos ni marcas) | $0 |
| **Recreación IA animada** | 6 | Veo 3.1 Fast, imagen a vídeo, 8 s a 1080p, audio descartado | 6 × $0,96 |
| Recreación IA fija | 1 (+2 de contingencia) | Imagen IA con Ken Burns | $0,06 cada una |

- **Recreaciones IA:**
  - b1-s1: animada desde la foto de dominio público `File:Deep Discoverer (51816198671).jpg`;
  - b1-s4, b4-s1, b5-s1, b5-s6 y b7-s5: animadas desde imágenes IA;
  - b5-s7: pez dragón, imagen fija.
- **Rotulación.** Todas llevan en pantalla **«AI recreation»**: la etiqueta ahora sale en el idioma del video y en español no cambia. Nunca se presentan como grabación real. No se recrea ningún animal concreto como si fuera un hallazgo.
- **Contingencia:**
  - b5-s2 (bioluminiscencia real): no se usa MBARI (tiene copyright). Si en la revisión no aparece material de dominio público de NOAA, pasa a imagen IA ($0,06) rotulada.
  - b5-s8 (nieve marina): igual.
- **Licencias verificadas y exclusiones:**
  - Las imágenes de NOAA OE suelen ser de dominio público. Se rechaza la imagen si el pie dice «copyright» o si es CC BY-SA, como `File:Deep Discoverer on NOAA Ship Okeanos Explorer.jpg`, excluida.
  - GEBCO es de dominio público con atribución.
  - Las imágenes de MBARI están **excluidas** (derechos reservados); una prueba lo impide.
  - «Control Room of the Okeanos Explorer R337» y «ROV and coral – Retriever Seamount» quedan como «licencia a confirmar» en la revisión.
- **Mapas: resuelto.** El mapa determinista solo dibujaba una retícula y un marcador. Ahora `remotion/map-land.json` guarda la tierra real recortada y simplificada por región: Pacífico (dos mapas), Rhode Island resaltado, bahía de Monterey, y Marianas con Filipinas, Taiwán y el sur de Japón como contexto.
  - Lo genera `content/long-form/ocean-deep-001/build_map_land.mjs`, a partir de `world-atlas@2` (Natural Earth 4.1.0) y `us-atlas@3` (U.S. Census Bureau), ambos con licencia ISC. Se instalan aparte y no son dependencias del proyecto.
  - Cada mapa es una caja 2:1 con proporción real y lleva la fuente en pantalla. El Pacífico se centra en el antimeridiano.
  - Fotogramas del render de producción: `docs/quality/ocean-deep-001/maps-and-cards.png`.
  - Una prueba comprueba la tierra, la proporción, que los marcadores queden dentro y que no haya tramos que crucen el mapa.
  - Los mapas de otros videos (sin `landKey`) no cambian.
- **Tarjetas grandes obligatorias en producción.** El manifiesto de muestra rechaza una tarjeta de texto sin `size: "large"` (código `card_size`, con prueba), y el render comprueba que cabe con `assertCardsFit`. Los fotogramas del render de producción están en `maps-and-cards.png`.
- **Tarjetas: hallazgo del ensayo, corregido.** En el primer ensayo las cifras salían como un «diagrama de un nodo» con letra pequeña. Ahora son tarjetas de texto grandes con la cita y el contexto. De paso se unificó la cifra de la tarjeta final a «Seen: about 0.001%», igual que en la narración.
- **Estética:** no se reutiliza el estilo medieval.
  - Paleta fría, desaturación 0,85 y contraste 1,05.
  - Cámara lenta: fija, acercamiento o desplazamiento.
  - Tarjetas limpias con cifras grandes.
  - Portada sobria arriba a la izquierda: «The *Deep* Ocean / What we've seen — and what we still don't know».

## 7. Primer minuto reutilizable

El primer minuto es **el beat b1 completo**: unos 50–55 s de narración, 7 escenas y la portada. No se rellena hasta 60 s. Se reutiliza en el episodio sin volver a pagar, por cuatro vías:

1. **Voz.** `long-form-narrate.ts` guarda cada beat en la caché durable de producción. La clave incluye videoId, beat, texto, voz y modelo. Al narrar el episodio (`beats=all`), b1 se encuentra `COMPLETED` y no se sintetiza otra vez.
2. **Clips e imágenes.** El primer minuto y el episodio usan el **mismo** `outputPrefix`, `ocean-deep-001/samples/episode`, y las mismas claves:
   - `ocean-b1-s01-lights-v1`;
   - `ocean-b1-s04-recede-v1`.

   El registro durable de Veo y las imágenes guardadas (`<prefix>/ai/<key>-still.png`) se reutilizan. Un clip ya pagado nunca se vuelve a pedir.
3. **Gasto.** Hay **un solo registro** del episodio, `<prefix>/state/paid-ledger.json`, con reserva previa y clave de idempotencia. El tope B es acumulado e incluye lo gastado en A.
4. **Montaje.** Las escenas s01–s07 del manifiesto del primer minuto pasan tal cual al del episodio; `leadingBeats` exige que la muestra sean los primeros beats del guion, en orden.

Si Hans aprueba el primer minuto, el episodio solo paga b2–b7.

## 8. Presupuesto

Tarifas:
- Veo 3.1 Fast a 1080p: $0,12 por segundo, es decir $0,96 por clip de 8 s.
- Imagen IA: reserva de $0,06.
- Voz: reserva conservadora de **$0,30 por 1.000 caracteres** (la de `long-form/cost.ts`).
  En Starter, la voz sale de la **cuota ya pagada** (sin excedente posible), así que su costo marginal real es $0. El tope la cuenta igual, para no subestimar.

### A — Primer minuto (b1)

| Concepto | Cálculo | USD |
|---|---|---|
| Voz b1 | 678 caracteres × 0,30/1k | 0,21 |
| Imagen IA (b1-s4) | 1 × 0,06 | 0,06 |
| Clips Veo | 2 × 8 s facturables × 0,12 (16 s) | 1,92 |
| **Subtotal** | | **2,19** |
| Recuperación | 1 clip (0,96) + 1 imagen (0,06) + 1 retoma de b1 (0,21) | 1,23 |
| **Máximo** | | **3,42** |

**Tope A propuesto: US$3,45.** Gasto típico sin incidencias: unos US$2,19, de los que US$1,98 salen en dinero.

### B — Episodio completo, acumulado (incluye A)

| Concepto | Cálculo | USD |
|---|---|---|
| Voz, 7 beats (b1 ya en caché si A se hizo) | 7.945 caracteres × 0,30/1k | 2,39 |
| Imágenes IA | 6 × 0,06 | 0,36 |
| Clips Veo | 6 × 8 s = **48 s facturables** × 0,12 | 5,76 |
| Contingencia b5-s2 y b5-s8 (imagen IA si no hay dominio público) | 2 × 0,06 | 0,12 |
| **Subtotal** | | **8,63** |
| Recuperación | 1 clip (0,96) + 1 imagen (0,06) + retoma de voz de hasta 1.150 caracteres (0,35) | 1,37 |
| **Máximo** | | **10,00** |

- **Tope B propuesto: US$10,00 acumulado**, igual al límite duro de la herramienta de muestras. Gasto típico: unos US$8,50; en dinero, unos US$6,24 (clips e imágenes), y la voz sale de la cuota.
- **Sin reintentos automáticos:**
  - cada operación se reserva antes de la llamada y se liquida después;
  - un fallo cuenta dentro del tope y detiene la ejecución;
  - una operación en estado incierto bloquea hasta revisarla.
- Una recuperación se lanza a mano con una **clave nueva**, dentro del margen.

## 9. Verificación gratuita realizada

- **Pruebas** (`ocean-prep.test.ts`):
  - rótulos en inglés, y en español sin cambios;
  - muestras multi-beat solo con los primeros beats;
  - guion en inglés de 1.300–1.500 palabras, cada afirmación con fuente o marcada como inferencia, sin la cifra del 80 %;
  - el storyboard cubre los 7 beats, las recreaciones IA van rotuladas con su licencia y no hay MBARI;
  - los fondos musicales existen y no llevan atribución a terceros.
- **Ensayo con render real**, sin claves de pago (voz de prueba local, recursos de prueba o deterministas y el fondo musical real), con la herramienta de producción:
  `produce-long-form-video.ts --language=en --music-bed=atomivid-suspense-a-v1 --provenance-labels`
  Resultados en la sección 9.1.

### 9.1 Resultado del ensayo

Hubo dos ensayos, ambos sin claves de pago (`paidApisCalled: false`, $0) y con render real de Remotion y masterización.

| Comprobación | Ensayo 1 | Ensayo 2 (tras las correcciones) |
|---|---|---|
| Formato | H.264 1920×1080 a 30 fps, AAC 48 kHz estéreo | igual |
| Duración | 499,9 s: 499,3 s de voz de prueba y la cola | igual |
| Guion y storyboard | 7 beats y 64 planos cargados, idioma `en` | igual |
| Subtítulos | en inglés, por frase, en la franja inferior | igual |
| Rótulo IA | «AI recreation» en los 7 planos IA | igual |
| Tarjetas de cifra | diagrama de un nodo con letra pequeña | tarjetas de texto con cita y contexto; la final dice «Seen: about 0.001%» |
| Música «Niebla baja» (tono de prueba filtrado) | −31 dB hasta 48 s, luego −51 dB: **callaba tras el primer ciclo** | −31 a −33 dB durante los 500 s; sin salto en la unión de 48 s (−33,3 / −33,5 / −33,5 / −33,6 dB) |
| Loudness integrado | −16,0 LUFS | −16,0 LUFS |

Límites del ensayo:
- La voz de prueba es un **tono continuo de 220 Hz**. Por eso no se puede comprobar aquí que la música suba en los silencios; eso lo cubren las pruebas unitarias de `soundCueVolume`.
- La herramienta de ensayo (CLI) usa la tarjeta de texto antigua, más pequeña. La producción (manifiesto) usa `size: "large"`, con un título de 72 px y un cuerpo de 44 px.
  - Se comprobó con `fitLargeCard` que caben 17 de las 18 tarjetas del storyboard con la cifra como título.
  - La de fuentes cabe como título «Sources» y la lista como cuerpo.
- Los planos de material real aparecen como marcadores de color con su búsqueda: el ensayo no descarga Commons ni Pexels.

Archivos del ensayo (no se suben al repositorio): `scratchpad/ocean-rehearsal2/ocean-rehearsal.mp4` y su `.report.json`.

### 9.2 Qué valida el ensayo y qué no

| Valida (sin gastar) | Requiere voz o vídeo reales |
|---|---|
| Guion en inglés cargado y segmentado en 7 beats; tiempos por beat y línea de tiempo | Ritmo real de Brian, y por tanto la duración final (con 1.398 palabras a 140–165 palabras/min: 8,5–10 min) |
| Subtítulos en inglés por frase, dentro de la zona segura | Pronunciación de los términos de la sección 3 |
| Composición 16:9 a 1920×1080, gráficos y mapas nuevos (Rhode Island, Monterey, Challenger Deep, Pacífico) | Calidad y fidelidad de los clips Veo al prompt («no añadir animales») |
| Rótulo «AI recreation» en inglés en los planos IA | Selección y licencia de cada foto o vídeo real (revisión de candidatos) |
| Fondo musical continuo en todo el video (bucle corregido) y nivel bajo la voz | Equilibrio final entre voz y música con la voz real |
| El render termina y el archivo se reproduce | Portada y miniatura con las imágenes reales |

## 10. Producción: pasos y autorizaciones

**Autorizaciones que se piden** (ninguna usada todavía):
1. Registrar `.github/workflows/long-form-ocean.yml` en la rama por defecto, fijando `PINNED_REF` al SHA revisado de esta rama. El código queda fijado. Los datos del episodio (solo JSON y MD de las dos carpetas del documental) se leen de `claude/ocean-documentary`, así se pueden ajustar tiempos y recursos tras la narración sin volver a registrar el workflow.
2. **Tope A de US$3,45** para el primer minuto.
3. Tras aprobar el primer minuto, **tope B de US$10,00 acumulado** para el episodio.

`LONG_FORM_REAL_RUN_CONFIRM` **no** se usa ni se activa: esta ruta no pasa por el orquestador de producción.

**Secuencia:**

| # | Paso | Gasto |
|---|---|---|
| 1 | `narrate-plan` (beats=b1): saldo, estado de la caché y registro | gratis |
| 2 | `narrate-run` (b1, `GASTAR`, cap 3.45) | voz b1 |
| 3 | `candidates`: tiempos por palabra reales y candidatos de Pexels y Commons (dominio público) | gratis |
| 4 | Revisión visual y de licencias; `minute1-manifest.json` con tiempos y recursos reales (commit de datos) | gratis |
| 5 | `prepare` (`allow_paid`, `GASTAR`, cap 3.45): 1 imagen y 2 clips | $2,0 aprox. |
| 6 | `render` (`approval`): `sample-approval-minute1.mp4` más URL firmada de 7 días; revisión de fotogramas, voz, música y subtítulos | gratis |
| 7 | **Hans aprueba el primer minuto** | — |
| 8 | `narrate-run` (all, cap 10): b1 reutilizado y b2–b7 | voz |
| 9 | Pasos 3–6 para el episodio (`episode-manifest.json`, b1 intacto), cap 10 | 5 clips y 5–7 imágenes |

**Bloqueos conocidos** (no se eluden):
- Desde este entorno, el proxy bloquea NOAA, Commons, Pexels y la descarga de artefactos de Actions (`productionresultssa4.blob.core.windows.net`). La búsqueda de candidatos corre en el runner de GitHub. Para revisar resultados desde aquí hay que permitir ese dominio en *Network access* del entorno; Hans también puede abrir directamente la URL firmada.
- Registrar el workflow en la rama por defecto requiere la autorización 1.

## 11. Etapa A — estado (27-09-2026)

Tope A autorizado: US$3,45 (acumulado en `ocean-deep-001/samples/episode/state/paid-ledger.json`).

| Paso | Ejecución | Resultado | Gasto |
|---|---|---|---|
| Registro | `c27fd5a` y `b8db203` en la rama por defecto (solo `long-form-ocean.yml`) | `PINNED_REF=9b53248…`; datos desde `claude/ocean-documentary-stage-a-2gmp97`; entrada `parts` y registros del paso en el artefacto | — |
| 1 `narrate-plan` | run 36319404819 | b1 sin caché, 678 caracteres, saldo 14.432, registro en $0 | gratis |
| 2 `narrate-run` b1 | run 36319526478 | Brian, `eleven_multilingual_v2`: 41,053 s, 128 palabras, en la caché durable | 678 caracteres de cuota; en el registro US$0,2034; **dinero: $0** |
| 3 `candidates` words | run 36319594264 | tiempos por palabra de b1 leídos; el paso cayó al pedir b2 (ventana de 900 s), sin costo | gratis |
| 3 `candidates` pexels+commons | runs 36319717981 y 36319901385 | correctos, pero el artefacto quedó en `productionresultssa10.blob.core.windows.net`, **bloqueado por el proxy** | gratis |

**Detenido antes de las llamadas de pago** (imagen IA y clips Veo): GitHub reparte los artefactos entre varias cuentas `productionresultssa*.blob.core.windows.net`; solo `sa4` está permitida en el entorno. Sin acceso no se pueden revisar los candidatos ni entregar el MP4 del render. Hace falta permitir `*.blob.core.windows.net` (o al menos `productionresultssa10`) en *Network access*.

Cortes de b1 con los tiempos reales (en silencios entre palabras): 0–5,03 · 5,03–11,70 · 11,70–14,19 · 14,19–18,05 · 18,05–24,13 · 24,13–29,07 · 29,07–33,54 · 33,54–36,10 · 36,10–42,253 (narración 41,053 s + cola 1,2 s).

### 11.1 Continuación (27-09-2026): primer minuto terminado

Con `*.blob.core.windows.net` permitido, los artefactos ya se descargan desde aquí (probado con `sa1`, `sa3`, `sa6`, `sa7`, `sa10` y `sa16`). La voz b1 se reutilizó de la caché: no se volvió a sintetizar ni se repitieron las búsquedas anteriores.

| Paso | Ejecución | Resultado | Gasto |
|---|---|---|---|
| Revisión de candidatos | artefactos de 36319717981 y 36319901385 | s02 `Expn0686`, s06 ETOPO (NOAA, DP) y s08 Pexels. Sin foto DP para la referencia de s01; para s03 solo una foto de 400×300 | gratis |
| 3 `candidates` commons (2.ª pasada, solo s1 y s3) | run 36322675471 (`search-spec-b1-r2.json`) | s01: `Deep Discoverer seabed Puerto Rico 11 April 2025.png` (DP). s03: `Coronate of the genus Atolla…` (DP, 1724×967) | gratis |
| 4 manifiesto | `minute1-manifest.json` (lo genera `build_minute1_manifest.py` con los tiempos por palabra) | 8 escenas cortadas en silencios, de 0 a 42,253 s; antetítulo de portada acortado a 32 caracteres (`kicker_too_long` bloqueaba el render) | gratis |
| 5 `prepare` sin pago | runs 36322811375 (el MP4 4K de Pexels superó el límite de Storage; se cambió a 38178142, 1080p) y 36322972116 | `PREPARE_OK`, licencias releídas | gratis |
| 5 `prepare` con pago | run 36323113770 (`GASTAR`, cap 3,45) | Veo s01 y s04, 8 s cada uno, e imagen IA s04. Sin fallos ni reintentos | **US$1,9753** (Veo 2 × 0,96 + imagen 0,055315) |
| 6 `render` aprobación | run 36323674245 | `sample-approval-minute1-portada.mp4`: H.264 1920×1080 a 30 fps, AAC 48 kHz, 42,25 s, −16,2 LUFS, true peak −2,3 dBTP; portada sin conflictos | gratis |

**Gasto acumulado en el registro: US$2,1787 de 3,45.**
- Dinero: US$1,9753 (clips e imagen).
- Cuota de ElevenLabs: 678 caracteres, anotados en el registro como US$0,2034; su costo marginal real es $0.
- Margen restante: US$1,2713.

Revisión de fotogramas (no se escuchó el audio):
- Aparecen subtítulos en inglés, rótulos «AI recreation» en s01 y s04, créditos NOAA/NCEI y Seabed 2030, y tarjetas grandes con cita.
- `blackdetect` marca de 11,7 a 14,27 s: es s03, una medusa sobre agua muy oscura que sí se ve. No hay negro real.
- En el clip de s01, Veo añadió hacia los 2–3 s una columna de partículas o burbujas sobre el vehículo. Va rotulado como recreación IA, pero el prompt pedía no añadir burbujas. Hans decide si lo acepta o se regenera con una clave nueva (US$0,96, cabe en el margen).
- b1 no tiene mapa determinista: los mapas con costas de `map-land.json` están en b2–b7. Aquí el mapa es el relieve ETOPO real.
- Falta el sonido de sonar o ROV (`missingSound`).

**Pendiente: Hans aprueba o rechaza el primer minuto.** La etapa B sigue sin autorizar.
