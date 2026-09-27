# «Texto a voz» para podcast (episodios largos y música)

Ampliación de «Texto a voz» (PR #16, ver `docs/VOICES.md`). Rama
`claude/tts-podcast`, apilada sobre `claude/voices-medieval-tts`.

**Nada de esto está activo.** Código, migración 0022, pruebas gratuitas y
documentación. No se aplicó la migración, no se cambió configuración
compartida, no se generó audio pagado y no se cambió el plan de ElevenLabs.

## 1. Qué hace

- **Episodios largos (piloto)**: hasta la capacidad técnica de 60.000
  caracteres por pieza, solo para las cuentas del piloto y con límites
  explícitos. Los usuarios generales siguen con 3.000 por pieza y 6.000 al
  mes.
- **Estimaciones en el formulario**: palabras, caracteres, duración
  aproximada como rango (120–140 palabras por minuto con pausas breves,
  identificada como estimación), consumo frente al máximo por pieza y a lo
  que queda del mes y, para el piloto, el saldo del servicio de voz y la
  reserva para el resto de Atomivid. El audio nunca se recorta, acelera ni
  rellena para llegar a una duración.
- **Voz**: el mismo selector (catálogo o «Mi voz» propia, con la propiedad
  comprobada en el servidor y en el worker). La voz «Hans podcast» se usa
  como cualquier voz propia; nada de esto la clona, borra ni prueba.
- **Música opcional**: Sin música, Suspenso o Documental
  (`TTS_MUSIC_ENABLED`).
- **Archivos**: sin música, la narración (`…-narracion.mp3`); con música,
  además el podcast con música (`…-podcast-con-musica.mp3`). Los dos se
  reproducen y descargan desde la misma pieza del historial. En Storage se
  guardan como `tts/<id>/narracion.mp3` y `tts/<id>/podcast-con-musica.mp3`
  (las piezas anteriores conservan su `audio.mp3`).
- **Mezcla independiente**: si la mezcla falla, la narración queda lista y
  se conserva. «Preparar mezcla», «Reintentar con» y «Cambiar música» usan
  la narración guardada: nunca vuelven a sintetizar la voz.

## 2. Límites: tres capas separadas (`src/lib/tts/limits.ts`)

| Capa | Valor | Dónde se aplica |
|---|---|---|
| Capacidad técnica por pieza | 60.000 caracteres (`TTS_TECHNICAL_MAX_CHARS`) | CHECK de `tts_jobs.script` (0022), validación del servidor. No es una cuota. |
| Usuarios generales | 3.000 por pieza, 6.000 por mes (sin cambios) | Servidor + disparador mensual (0021) + CHECK por pieza (0022) |
| Piloto de episodios largos | Solo con `TTS_LONG_PILOT_EMAILS`/`_USER_IDS` **y** `TTS_LONG_PILOT_MAX_CHARS_PER_PIECE` **y** `TTS_LONG_PILOT_MAX_CHARS_PER_MONTH`. Sin alguno de ellos, la cuenta usa los límites generales. | Servidor + base (límite por pieza y mensual guardados en la fila) |
| Un episodio largo a la vez | Como máximo uno en cola o en proceso en toda la cuenta | Índice único parcial `tts_jobs_one_active_long_pilot` (0022) |
| Saldo real del proveedor | Consulta gratuita antes de gastar | Al crear (episodio largo) y en el worker |

La protección real frente a saldo insuficiente y a otros trabajos que
usan la misma cuenta está en la sección 3.

## 3. Protección real: saldo insuficiente y otros trabajos

La cuenta de ElevenLabs es **una sola** para Reel, Avatar, Long Form y
«Texto a voz». Reel, Avatar y Long Form **no reservan caracteres** antes de
gastar. Por eso la reserva de 3.000 caracteres (`TTS_PROVIDER_RESERVE_CHARS`)
**no es una reserva transaccional compartida**: es un margen que el piloto
se obliga a dejar sin tocar al decidir si empieza o sigue. Nada impide que
otro producto consuma ese margen, ni que lo consuma entre dos consultas.

**Garantizado por la base de datos** (tras aplicar 0022):

- como máximo un episodio largo en cola o en proceso en toda la cuenta
  (índice único parcial `tts_jobs_one_active_long_pilot`); un segundo envío
  recibe «Ya hay un episodio largo en preparación…»;
- límite mensual por usuario (disparador de 0021) y límite por pieza
  guardado en la fila (CHECK `characters <= max_chars_per_piece`);
- el mismo `client_request_id` devuelve la misma pieza (doble clic).

**Comprobaciones del worker (mejor esfuerzo, no atómicas)**, solo con el
proveedor real y en episodios largos:

1. Al crear: si el saldo menos la reserva no alcanza para el texto, la pieza
   no se crea («El servicio de voz no tiene caracteres suficientes ahora
   para este texto (quedan N disponibles). No se creó la pieza.»). El
   formulario muestra el mismo aviso y deshabilita el envío cuando pudo
   leer el saldo.
2. Al empezar o reanudar, antes de gastar:
   - si hay videos generándose (`video_requests` en `processing` con render
     iniciado hace menos de 6 h) se detiene: «Hay videos generándose ahora
     mismo y usan la misma cuenta de voz. Reintenta cuando terminen; no se
     cobró nada de lo que falta.»; si no puede comprobarlo, también se
     detiene;
   - exige saldo ≥ lo que falta + los caracteres de otras piezas de «Texto
     a voz» en proceso + la reserva. Si no alcanza: «El servicio de voz no
     tiene caracteres suficientes para terminar esta pieza. Faltan X
     caracteres y hay Y disponibles (saldo S, menos 3.000 reservados para el
     resto de Atomivid y Z de otras piezas en curso). No se cobró nada de lo
     que falta; puedes reanudarla cuando haya saldo.»
3. Cada 8 fragmentos sintetizados vuelve a consultar el saldo. Si ya no
   alcanza: «El saldo del servicio de voz bajó mientras se generaba (otras
   funciones usan la misma cuenta). Faltan X… Se detuvo antes de agotarlo:
   lo generado se conserva y «Reanudar» no lo vuelve a cobrar.»
4. Si aun así el proveedor responde sin saldo (401 `quota_exceeded` o
   402), el mensaje es de saldo, no de credenciales: «El servicio de voz se
   quedó sin caracteres mientras se generaba (la cuenta es compartida con el
   resto de Atomivid). Lo ya generado se conserva y «Reanudar» no lo vuelve
   a cobrar cuando haya saldo.»

**Lo que no está protegido**:

- un Reel, Avatar o Long Form que empiece **durante** un episodio no se
  bloquea ni se avisa;
- entre dos consultas (hasta 8 fragmentos, ≈ 7.200 caracteres) otro
  producto puede gastar el saldo; el peor caso es que ese otro producto, o
  el siguiente fragmento del episodio, falle por falta de saldo;
- la consulta de saldo no reserva nada en ElevenLabs.

Todo esto está cubierto por pruebas con proveedores simulados en
`podcast.test.ts` (saldo insuficiente al empezar, reserva y otras piezas en
curso con las cifras del mensaje, saldo que baja a mitad, 401
`quota_exceeded` a mitad con reanudación sin repetir síntesis, videos en
curso). No se probó con la cuenta real.

## 4. Generación, reanudación y tiempo

- Segmentación y contexto entre fragmentos sin cambios (≤ 900 caracteres;
  `previous_text`/`next_text`). Pausas de 650 ms entre párrafos y de 180 ms
  entre oraciones. Cada borde lleva un fundido de 8/15 ms para evitar
  clics, y un nivelado suave igualar volúmenes: solo actúa si un fragmento
  se aparta más de 1,5 dB de la mediana, y con un tope de ±3 dB.
- Cada fragmento pasa por la caché de voz durable y el registro de gasto.
  Al reanudar, lo ya generado se reutiliza sin cobrarse. Un fragmento en
  estado incierto detiene la pieza en vez de repetirse.
- Doble clic: `client_request_id` único. Doble ejecución: reclamo
  condicional (`queued → processing`), grupo de concurrencia del workflow y
  reclamo propio de la mezcla (`mix_status pending → processing`).
- **Presupuesto de tiempo**: el worker solo se detiene entre fragmentos,
  cuando no queda tiempo para el siguiente o para unir, y deja la pieza
  «pausada» con «Reanudar». Una reanudación a la que solo le falta unir
  une siempre (evita pausas en bucle). `TTS_WORKER_BUDGET_SECONDS` vale 11
  min por defecto, que cabe en el `tts.yml` registrado hoy (paso de 15
  min); el `tts.yml` de esta rama sube a 45 min (paso de 52, trabajo de
  60).
- **Tiempos medidos** (validación gratuita, sección 8): para 2.763 s de
  narración (46 min 03 s), unir y masterizar tardó 123 s y mezclar y
  masterizar 239 s en este entorno, con la CPU compartida, y 99 s y 201 s
  en el runner de CI (run 36280351086). La síntesis real no se midió
  (sin gasto): con ~58 fragmentos a 6–10 s cada uno serían ≈ 6–10 min. Con
  el `tts.yml` registrado hoy (11 min de presupuesto), un episodio de 45 min
  se pausaría al menos una vez y habría que pulsar «Reanudar»; con el de
  esta rama (45 min) cabe en una ejecución.
- Tamaño: la tasa del MP3 baja por escalones (128 → 64 kbps) para no pasar
  de 47 MiB por archivo. El límite demostrado de Storage es 50 MiB, ver
  `output-policy.ts`. Con 46 min se mantiene en 128 kbps (44,2 MB la narración y 44,5 MB la mezcla).

## 5. Música (`src/lib/tts/music-beds.ts`)

- **Opciones**: Sin música, Suspenso y Documental. Hay dos fondos por
  estado de ánimo (Suspenso A «Niebla baja» y B «Pasillo»; Documental A
  «Archivo» y B «Horizonte»). El fondo es fijo por pieza y se registra en
  `music_track_id`.

### Procedencia de la música

- **Código**: `music-beds.ts` lo escribió el asistente de programación
  (Claude Code) en este repositorio. Genera el audio con osciladores, ruido
  filtrado y envolventes a partir de una semilla fija: el mismo fondo sale
  idéntico en cada ejecución.
- **Dependencias**: ninguna biblioteca musical ni de síntesis. ffmpeg (ya
  usado por el resto del producto) solo mezcla, masteriza y codifica.
- **Material musical**: no usa muestras, grabaciones, loops ni partituras
  de terceros. Los acordes son progresiones corrientes (menores y modales)
  que no pertenecen a nadie.
- **Qué no se afirma**: esto documenta cómo se hizo; **no es una garantía
  jurídica absoluta** de que ningún fragmento se parezca a una obra
  existente ni sustituye una revisión legal si Atomivid la necesita. No
  hubo revisión legal, y la protección por derechos de autor del material
  creado con asistencia de IA varía según el país. Cada fondo lo registra
  así en `MUSIC_BEDS` (fuente y licencia).
- **Por qué no se usan las 20 pistas de Eleven Music del banco de Reels**:
  - sus términos para planes de pago restringen algunos usos comerciales
    (TV o radio fuera de internet, cine, anuncios, bibliotecas musicales);
  - al menos una fuente secundaria menciona restricciones de «streaming»;
  - no fue posible leer la fuente primaria desde este entorno
    (elevenlabs.io bloqueado), así que su uso en podcasts publicados no
    quedó comprobado.

  Las 2 pistas de Pixabay son corporativas o motivacionales, no suspenso ni
  documental. Tampoco se pudieron descargar pistas CC0 (bancos bloqueados
  en este entorno). No se contrató ni generó música de pago.

### Calidad: qué está medido y qué no

- **Medido por código**:
  - sin recorte (0 muestras) y niveles dentro de objetivo;
  - vuelta del bucle: el fondo se renderiza circularmente. En la forma de
    onda, el salto en el punto de unión es menor que el percentil 99 de los
    saltos normales entre muestras en los cuatro fondos. En el nivel
    (ventanas de 100 ms) la vuelta cambia 0,01 dB en «Horizonte» (46 min;
    variación normal p99 1,9 dB) y 0,67 dB en «Pasillo» (6 min; p99
    1,11 dB). **Una discontinuidad medida pequeña no demuestra que la
    vuelta sea imperceptible**: eso solo se sabe escuchando.
- **Visto**: espectrogramas con los cambios de acorde y las subidas de
  tensión.
- **Escuchado**: **nadie lo ha escuchado**. La calidad artística y de
  escucha **no está aprobada** hasta que Hans escuche los fondos y los
  extractos (entrada, vuelta del bucle, salida) de Suspenso y de Documental.
- **Mezcla** (`podcast-audio.ts`, parámetros en `MIX`):
  1. Entra la música con un fundido de 3 s.
  2. A los 3,5 s baja 14 dB durante 2,5 s.
  3. La voz empieza a los 6 s.
  4. La música queda 20 LU por debajo de la voz durante toda la narración
     (y con −4 dB en 2,2 kHz, la zona de inteligibilidad).
  5. Al terminar la voz, sube en 2,5 s, se mantiene 3 s y sale con un
     fundido de 5 s.

  El fondo se prolonga repitiendo su bucle. Sin efectos de sonido ni
  controles avanzados.
- **Sonoridad** (recomendación AES para podcast):
  - narración mono a −19 LUFS (equivale a −16 en estéreo);
  - mezcla estéreo a −16 LUFS;
  - pico real ≤ −1,5 dBTP en ambas, verificado sobre el MP3 final.

## 6. Masterización compartida (defecto documentado)

**No afecta a esta entrega.** El podcast no usa `audio-master.ts`; usa su
propio `masterToMp3`, que siempre corrige desde el original sin pérdida y
verifica el MP3 final en un bucle acotado.

La causa de la prueba intermitente
`audio-master.test.ts › masterización con margen…` está reproducida con
semillas fijas (1, 2, 3, 10, 12 del mismo ruido rosa con transitorios):

1. En la segunda pasada, `loudnorm` con `linear=true` no puede aplicar la
   ganancia lineal (el pico medido + la ganancia superaría el techo) y cae
   a **modo dinámico**. Resultado: −17,4 LUFS en la semilla 12, en vez de
   −16; en el barrido, entre −17,4 y −17,9.
2. La pasada correctiva de pico **vuelve a codificar AAC sobre el AAC ya
   codificado** y no vuelve a verificar. El sobrepico nuevo no está
   acotado: en la semilla 12 pasó de −1,21 a −0,81 dBTP después de corregir
   −0,42 dB, y en la semilla 10 quedó en −1,21. Ambos superan −1,5.

El mismo tipo de señal pasa en las cinco semillas con la masterización del
podcast (`podcast.test.ts`).

La corrección natural para `audio-master.ts` es aplicar la corrección desde
la entrada sin pérdida y verificar en bucle. **No se aplicó**: esa ruta
(`truePeakMarginDb`) la usa Long Form, y cambiarla altera Reel, Avatar o
Long Form. Requiere autorización propia y volver a validar esos productos.
La prueba intermitente sigue como estaba (sin relajar ni elegir semillas).

## 7. Capacidad y consumo

Tres cifras distintas que no deben confundirse:

| Concepto | Valor | Qué significa |
|---|---|---|
| Capacidad del período | 38.002 caracteres | Plan Starter de ElevenLabs, por período. Se renueva el 2026-10-16 03:08 UTC. |
| Saldo disponible | 14.888 en la última lectura | Solo lectura (run 36269569261, 2026-09-26 20:27 UTC): 23.114 usados. Después hubo una clonación (81 caracteres) y una pieza corta de Hans, así que hoy es algo menor; no se volvió a leer. |
| Longitud real del texto | la mide el formulario | Caracteres cobrables del guion (≈ 6,0 por palabra en español, medido: 35.502 / 5.908). |

**Máximo para un episodio**: 38.002 − 3.000 de reserva = **35.002
caracteres**, y solo si el período está completo y nada más consumió
antes. Cualquier consumo de Reel, Avatar, Long Form o «Texto a voz» en el
mismo período lo reduce.

Cuánto texto da 45 minutos depende del ritmo real de la voz, que no se
midió con ElevenLabs (sin gasto):

| Ritmo de la voz | Palabras para 45 min | Caracteres (≈ 6,0 por palabra) | ¿Cabe en 35.002? |
|---|---|---|---|
| 120 ppm | 5.400 | ≈ 32.400 | Sí (sobran ≈ 2.600) |
| 130 ppm | 5.850 | ≈ 35.100 | No por ≈ 100 |
| 140 ppm | 6.300 | ≈ 37.800 | No por ≈ 2.800 |

Así que **no todo episodio de 45 min queda excluido**: con una voz pausada
(≈ 120 ppm) un guion de ≈ 32.400 caracteres cabe con la reserva en un
período completo. El texto de la validación gratuita (35.502 caracteres,
46 min a 130 ppm simulados) **no** cabría: supera los 35.002 en 500.

Costo según el registro de la app (US$0,10 por 1.000 caracteres, el mismo
que usa el registro de gasto; el tope del worker es 1,2 × costo + 0,01):

| Episodio | Caracteres | % del período | Costo registrado |
|---|---|---|---|
| 30 min (120–140 ppm) | 21.600–25.200 | 57–66 % | US$2,16–2,52 |
| 45 min (120–140 ppm) | 32.400–37.800 | 85–99 % | US$3,24–3,78 |
| Validación simulada (46 min) | 35.502 | 93,4 % | US$3,55 |

**Hoy** (≤ 14.888 disponibles, menos 3.000 de reserva = ≤ 11.888) no cabe
ni un episodio de 30 minutos. Tras la renovación cabe uno de 30 min
(hasta ≈ 25.200; deja ≈ 12.800, reserva incluida, para todo lo demás) o uno
de 45 min de voz pausada (≈ 32.400; deja 5.602, reserva incluida), no ambos.

## 8. Validación gratuita (proveedores simulados, audio real con ffmpeg)

`scripts/podcast-local-validation.ts` usa el mismo worker (`runTtsJob`), la
misma unión, masterización y mezcla que en producción, con base y Storage
en memoria y un proveedor de voz **simulado** (habla sintética: formantes
con ritmo silábico). Falla si la narración **medida** dura menos de
`--minutes` (45 → 2.700 s). Se ejecuta en `e2e-fixture-evidence.yml` de
esta rama.

**Corrección**: la validación anterior (voz simulada a 150 ppm) midió
2.399,8 s de narración (≈ 40 min) y 2.417,2 s de mezcla (≈ 40 min 17 s).
Eso **no** era evidencia de 45 minutos, aunque el documento lo presentaba
así. La nueva usa 130 ppm y exige el mínimo medido.

Resultado de la nueva validación (Documental, fondo B «Horizonte»):

- guion: 5.908 palabras, 35.502 caracteres, 58 fragmentos (estimación del
  formulario ≈ 42–50 min);
- **narración medida: 2.763,4 s (46 min 03 s)**, igual a la esperada;
- **mezcla completa medida: 2.780,7 s (46 min 21 s)** = narración + 17,3 s
  (6 s de entrada y 11,3 s de salida);
- recuperación, en 3 ejecuciones:
  1. pausa por tiempo tras 18 de 58 fragmentos (18 llamadas);
  2. fallo rechazado sin cobro (400) en la llamada 30, con 29 fragmentos
     guardados;
  3. termina (59 llamadas en total);
- **ninguna síntesis repetida**: 59 llamadas para 58 fragmentos; la única
  repetida es la rechazada, que no se cobra;
- consumo simulado: 35.502 caracteres cobrables, cada fragmento una sola
  vez = US$3,55 según el registro, 93,4 % del período; **no cabe** en un
  período completo con la reserva (sección 7);
- sonoridad: narración −19,0 LUFS / −3,6 dBTP; mezcla −16,0 LUFS /
  −3,1 dBTP;
- 0 muestras recortadas; silencio final −51,9 dB;
- voz sobre música: entre 19,6 y 20,4 dB en cada uno de los 46 minutos;
- vuelta del bucle: 0,01 dB frente a una variación normal (p99) de 1,9 dB
  (medido, no escuchado);
- tamaño: 44,2 MB la narración y 44,5 MB la mezcla (128 kbps, bajo el techo
  de 47 MiB);
- tiempos en el runner de CI (run 36280351086): unir y masterizar 99 s;
  mezclar y masterizar 201 s (en este entorno, con la CPU compartida, 123 s
  y 239 s). CI midió las mismas duraciones, niveles y relaciones: el
  proceso es determinista.

Validación corta con **Suspenso** (`--minutes 5 --music suspense`, fondo B
«Pasillo»): narración 346,4 s, mezcla 363,8 s; −19,0 / −3,5 y −16,0 /
−3,0; voz sobre música 19,2–19,8 dB; vuelta del bucle 0,67 dB (p99
1,11 dB); pausa, fallo rechazado y reanudación sin síntesis repetidas.

**Límite de esta evidencia**: la «voz» es una señal sintética con
formantes y ritmo silábico. Que tenga energía en las bandas del habla **no
demuestra que las palabras se entiendan** sobre la música: la relación voz
/ música de 20 dB es una medida de nivel, no de inteligibilidad. La
duración real con ElevenLabs depende de la voz.

`src/lib/tts/podcast.test.ts` (en `test:unit`) cubre además: límites por
capa y que el piloto exija límites explícitos; estimaciones; doble envío y
un episodio largo a la vez; las comprobaciones de saldo y videos en curso
de la sección 3; pausa por tiempo y reanudación; mezcla y su fallo sin
perder la narración; «cambiar música» sin sintetizar y rechazado para otra
usuaria; masterización acotada en 5 semillas; la vuelta del bucle; la
migración 0022 aditiva.

## 9. Verificación de la interfaz real (móvil y escritorio)

`scripts/ui-verification/podcast-ui.ts` levanta la app real (`next dev`)
contra un Supabase simulado en memoria (`mock-supabase.ts`: autenticación,
REST con RLS por usuario e índices únicos, Storage con descargas) y la
recorre con Chromium a 1280×900 y a 390×844. La voz es la de prueba
gratuita (`VOICE_PROVIDER=fixture`); no usa la voz de Hans. También corre
en `e2e-fixture-evidence.yml` y deja capturas y `resultado.json`.

Resultado: **52 comprobaciones correctas, 0 fallos, 2 pendientes**.

- **Contador y límites**: palabras, caracteres frente al máximo, duración
  como rango estimado, consumo frente a los límites del piloto, aviso de
  máximo por pieza y envío deshabilitado; otra cuenta ve solo sus piezas y
  el límite general de 3.000.
- **Música**: tres opciones, selección, aviso de dos archivos.
- **Estados**: en proceso con progreso, pausada con «Reanudar», mezcla
  fallida que conserva la narración y ofrece «Preparar mezcla».
- **Reanudar**: completa la pieza pausada.
- **Dos archivos**: dos reproductores que cargan el audio (12,7 s y
  30,0 s) y dos descargas válidas (`…-narracion.mp3` y
  `…-podcast-con-musica.mp3`), en móvil y escritorio.
- **Flujos**: crear con Suspenso (el worker local termina narración y
  mezcla); doble envío crea una sola pieza; «Cambiar música» hace una
  mezcla nueva sin tocar la narración; sin desplazamiento horizontal; sin
  errores de consola.

**Defectos reales encontrados y corregidos** con esta verificación:

1. El `client_request_id` del formulario cambiaba con cada refresco
   automático del historial (cada 4 s con piezas en curso), así que un
   reenvío tras un refresco podía crear una segunda pieza. Ahora se fija al
   montar el formulario y solo cambia tras crear una pieza.
2. El saldo agotado a mitad (401 `quota_exceeded`) se informaba como error
   de credenciales. Ahora se informa como falta de saldo (sección 3).

**Pendiente** (no verificable sin gasto ni cuenta real):

- el saldo real del proveedor en el formulario (sin clave, se verificó solo
  el texto «No se pudo consultar el saldo…»);
- audio real de ElevenLabs y su escucha.

## 10. Plan de activación (cada paso requiere autorización)

Un solo plan, en este orden:

1. **Migración 0022** en el Supabase compartido con producción:
   `apply-supabase-migration.yml` con `ref=claude/tts-podcast` y
   `migration_file=0022_tts_podcast.sql`. Aditiva: amplía el CHECK del
   guion y agrega columnas con valores por defecto, CHECK nuevos y un
   índice parcial. El worker fijado hoy (0a53459) y la app de PR #16 siguen
   igual: no leen las columnas nuevas.
2. **Volver a registrar `tts.yml`** en la rama por defecto, fijado al
   commit revisado de esta rama, con 60/52 min y
   `TTS_WORKER_BUDGET_SECONDS=2700`. Solo después de 0022. Afecta a toda
   pieza de «Texto a voz» (la narración pasa a nivelarse y masterizarse).
3. **Preview de `claude/tts-podcast`** con las variables de la rama de
   voces (`TEXT_TO_SPEECH_ENABLED`, `MY_VOICE_ENABLED` y su lista,
   `GH_WORKER_*`, `NEXT_PUBLIC_SITE_URL`, el mismo Supabase) más
   `TTS_MUSIC_ENABLED=true`. Sin variables del piloto todavía.
4. **Hans escucha** los cuatro fondos y los extractos de Suspenso y
   Documental. Sin su aprobación no se activa la música.
5. **Prueba real breve con música** (sección 11), tope US$0,15.
6. **Primer episodio largo**, tras la renovación del 2026-10-16 y con
   autorización propia:

   ```
   TTS_LONG_PILOT_EMAILS=hanzmo16@gmail.com
   TTS_LONG_PILOT_MAX_CHARS_PER_PIECE=25000   # clase 30 min
   TTS_LONG_PILOT_MAX_CHARS_PER_MONTH=25000
   TTS_PROVIDER_RESERVE_CHARS=3000            # por defecto
   ```

   Deja ≈ 13.000 caracteres del período para todo lo demás. Ese episodio
   mide el ritmo real de la voz de Hans.
7. **45 minutos**: si el ritmo medido es ≈ 120 ppm, subir ambos límites a
   32.400 en un período sin otro consumo grande (sección 7). Si es más
   rápido, 45 min no cabe en Starter con la reserva y requiere más
   caracteres, una decisión de plan de Hans.

## 11. Prueba real breve con música (propuesta, pendiente de autorización, no ejecutada)

- **Texto**: ≤ 1.100 caracteres (≈ 180 palabras, ≈ 1,3–1,5 min estimados).
- **Voz**: «Hans podcast», o una del catálogo. No se clona nada.
- **Música**: Documental; luego «Cambiar música» a Suspenso, que no vuelve
  a sintetizar.
- **Límites**: cabe en los generales; no necesita el piloto.
- **Costo estimado**: ≈ US$0,11 (1.100 caracteres a US$0,10 por 1.000),
  ≈ 7 % del saldo disponible. Mezclar y cambiar de música no cuesta nada.
- **Tope: US$0,15.** El registro de gasto del worker ya la limita a
  1,2 × 0,11 + 0,01 ≈ US$0,142.
- **Requisitos previos**: pasos 1–3 de la sección 10.

## 12. Pendiente

- Escucha de Hans: fondos, extractos, vuelta del bucle, inteligibilidad de
  la voz sobre la música. La calidad artística no está aprobada.
- Audio real de ElevenLabs: duración real, ritmo de la voz y consumo real.
- Saldo real del proveedor mostrado en el formulario.
- El defecto de `audio-master.ts` (sección 6), que requiere autorización
  propia.
