# Decisiones técnicas — ATOMIVID

Documento breve de decisiones no obvias y su razón. El README cubre el
"cómo"; esto cubre el "por qué", para no tener que redescubrirlo después.

## Patrón de adaptadores (guion/voz/footage/música)

Cada etapa externa tiene una interfaz común con una implementación "real"
(llama a la API) y una "fixture" (determinística, sin red), seleccionada
por env var con auto-fallback a fixture si falta la API key. Esto permitió
probar el pipeline completo de extremo a extremo (incluyendo el render de
Remotion) en un entorno sin salida de red hacia ningún proveedor externo,
sin lo cual no se podría haber verificado nada real durante el desarrollo.

## Dos fases: guion primero, render después

`generateScriptForRequest()` (barato: solo Claude) y
`generateVideoFromScript()` (caro: voz+footage+música+render) están
separadas, con una pantalla de revisión entre medio. Evita gastar en el
pipeline caro sobre un guion que el usuario habría descartado, y le da
control real sobre el contenido antes de comprometer presupuesto.

## Worker en background: GitHub Actions, no un servicio de pago

Se evaluaron GitHub Actions, Remotion Lambda, Railway y Render.com (tabla
completa en el README). Se eligió GitHub Actions para esta etapa porque:
- Costo $0 dentro del límite gratuito (2,000 min/mes en repos privados).
- Reutiliza el mismo código Node/Remotion que ya corre en este repo — cero
  reescritura del pipeline, solo un nuevo entrypoint
  (`scripts/render-worker.ts`) y un workflow.
- Railway/Render.com ya no tienen una capa gratuita real para una carga de
  trabajo con Chromium (necesitan un plan pago desde el primer minuto).
- Remotion Lambda es la opción correcta para escalar con usuarios de pago
  (pago por uso, sin cuota fija, producto oficial de Remotion para esto),
  pero requiere una cuenta de AWS — se deja documentada como el siguiente
  paso, no implementada, para no contratar infraestructura de pago sin
  autorización.

La abstracción `src/lib/worker/` (mismo patrón que los adaptadores de
proveedores) existe específicamente para que sustituir GitHub Actions por
Remotion Lambda más adelante sea escribir un nuevo `RenderWorker`, no
reescribir la ruta API ni el pipeline.

## Bucket de Storage privado + URLs firmadas (en vez de público)

El bucket "videos" era público de lectura desde el Paso 2. Se cambió a
privado (migración 0006) porque no hay forma de exigir "el usuario debe
ser dueño para descargar" en un bucket público — cualquiera con el link
(adivinable o filtrado) podía verlo. Ahora `video_path` guarda solo la
ruta; el historial firma una URL de corta duración recién después de que
la consulta a `video_requests` (filtrada por RLS a las filas del usuario
actual) confirma la propiedad. Se hizo ahora, antes de tener usuarios
reales, precisamente para no tener que migrar datos en producción después.

## Límites de entrada como defensa en profundidad (no solo el UI)

El `<select>` de duración en `/dashboard/new` ya limitaba a 30/60/90s, pero
un Server Action se puede invocar directamente sin pasar por ese `<select>`
— así que se agregó validación server-side (duración/longitud de
tema/estilo) además de un CHECK constraint en la base de datos (migración
0007). Lo mismo para el PATCH del editor de guion (tope de escenas y de
longitud de texto): el guion editado alimenta directamente el costo de
ElevenLabs (por carácter) y la duración del render, así que no puede
quedar sin límite solo porque la UI "normalmente" no permite excederlo.

## Música: banco curado manualmente, no una API en vivo

Ni Pixabay Music (sin endpoint de audio en su API pública) ni Freesound
(API gratis pero solo para uso no comercial) dan una integración en vivo
lista para un SaaS comercial sin pasos extra (investigación completa en el
README). En vez de bloquear el resto del sistema esperando eso, se
construyó `MUSIC_MANIFEST` — un banco curado manualmente por el usuario
(con fuente/autor/licencia registrados) con selección por estilo, y
`scripts/render-worker.ts` se niega a generar un video real mientras el
manifest esté vacío, para que el tono de prueba del fixture nunca le
llegue a un usuario.

## Costo estimado por video: aproximado a partir de lo que ya medimos, no facturación exacta

Ningún proveedor (Claude, ElevenLabs, GitHub Actions) expone el costo real
de una llamada individual sin pegarle a su propia API de facturación (con
su propio costo/latencia/riesgo de error). En vez de eso, `generation_costs`
(migración 0008) acumula lo que el pipeline ya sabe sin llamadas extra:
caracteres enviados a voz, número de llamadas al modelo de guion (estimando
tokens a ~4 caracteres/token, ver `src/lib/billing/pricing.ts`), duración
del video, tiempo de render y bytes subidos a Storage. Las tarifas usadas
para convertir eso a USD son valores por defecto públicos, siempre
sobreescribibles por variable de entorno (`PRICING_*` en `.env.example`) —
nunca hardcodeadas como si fueran el precio real de tu cuenta. Sirve para
comparar el costo relativo entre videos y detectar solicitudes anormalmente
caras, no para reconciliar con la factura exacta.

El registro de costo nunca puede tumbar un video que sí se generó bien: si
falla (tabla no migrada, red, etc.), se captura y se registra como warning
en logs — ver el `.catch()` alrededor de `recordVideoGeneration`/
`recordScriptCall` en `src/lib/video/generate.ts` y las rutas de guion.

## Idioma como elección explícita del usuario, no inferido del tema

Antes, el guion "adivinaba" el idioma del texto que el usuario escribía
como tema — funcionaba mientras el tema estuviera en el idioma deseado,
pero no daba control real (p. ej. un tema en español para narración en
inglés). Se agregó `language` (columna en `video_requests`, selector en
`/dashboard/new`) y se pasa explícitamente al prompt de Claude ("responde
SIEMPRE en X, sin importar el idioma del tema"). ElevenLabs también puede
recibir una voz específica por idioma (`ELEVENLABS_VOICE_ID_ES`/`_EN`) —
opcional, porque una sola voz multilingüe (turbo v2.5) ya funciona, solo
que con acento si no es nativa en ese idioma.

## Footage dinámico: video primero, fotografía como respaldo

El proveedor Pexels consulta primero su catálogo de videos verticales y elige
un MP4 de al menos 720 px de ancho, favoreciendo 1080×1920 sin descargar el
original más pesado. También exige que el clip cubra la duración completa de
la escena para evitar congelar su último cuadro. Si una búsqueda no tiene un
clip adecuado, conserva el flujo anterior con fotografía y Ken Burns. Así se
mejora el movimiento visual sin sumar un proveedor pagado ni volver frágil el
pipeline ante búsquedas con poco material.

## Música profesional: mezcla dentro de Remotion, no con ffmpeg externo

`<Audio volume={...}>` de Remotion acepta una función `(frame) => number`
(sample-accurate, evaluada por Remotion al renderizar) — así que los
fades/ducking de voz y música (`remotion/audio-mix.ts`) se implementan como
funciones puras de volumen por segundo, sin un paso de preprocesamiento de
audio con `ffmpeg`. Se consideró recortar/normalizar la pista con `ffmpeg`
antes de subirla, pero: (1) el worker de GitHub Actions no trae `ffmpeg`
preinstalado (confirmado en una fase anterior, ver README), y Remotion usa
su propio binario interno, no el del sistema — depender de `ffmpeg` del
sistema habría sido una dependencia nueva y frágil entre entornos; (2) el
`loop` de `<Audio>` ya rellena la música hasta la duración del video sin
necesidad de recortarla/loopearla manualmente. El resultado es más simple
(cero pasos de audio adicionales, cero archivos temporales de audio) y más
testeable (las funciones de volumen son puro TypeScript, sin Remotion ni
React — ver `audio-mix.test.ts`).

## Selección de música por tono, no aleatoria ni por API en vivo

Confirmado (otra vez, en esta fase) que Pixabay Music no tiene endpoint de
audio en su API pública — ver la investigación ya documentada arriba. En
vez de construir una integración en vivo que no existe, se invirtió el
esfuerzo en la calidad de la selección sobre la biblioteca curada: tono
inferido de estilo + palabras clave del tema/guion (`tone.ts`), puntuación
por coincidencia de tono con desempate determinístico por seed
(`select.ts`). La seed determinística usa FNV-1a + módulo entero, no un
hash polinomial simple normalizado a float — se detectó empíricamente
(ver `select.test.ts`) que ese segundo enfoque agrupaba seeds con el mismo
prefijo (p. ej. `"req-1".."req-9"`, el patrón típico de un requestId de
prueba) en el mismo índice, por mal "avalanche" del hash. Con UUIDs reales
el efecto sería menos notorio pero igual de incorrecto en principio — se
corrigió antes de que importara.

## Costo de música: no se inventa un cargo por algo gratis

`generation_costs.estimated_cost_usd` solo suma una tarifa de música
(`PRICING_MUSIC_USD_PER_TRACK`) si el video terminó usando una pista real
(`music_provider != "none"`) — y esa tarifa es $0 por defecto, porque la
biblioteca curada actual (Pixabay Music/Mixkit) es gratis bajo sus
licencias de uso comercial. La variable existe para el día en que se
conecte un proveedor de pago (p. ej. Epidemic Sound), no para simular un
costo que hoy no existe.

## Migración 0009: aplicada y confirmada

`0009_music_traceability.sql` agrega columnas (`music_track_id`, `_title`,
`_author`, `_license`, `_source_url`, `music_fallback_reason`) a
`generation_costs` para guardar qué pista sonó en cada video. Se preparó
primero sin aplicar (instrucción explícita de no tocar Supabase sin
autorización) mientras la misma metadata se emitía solo en logs
estructurados; el usuario la aplicó y verificó manualmente, y
`recordVideoGeneration` (`src/lib/billing/usage.ts`) ya escribe esas
columnas en cada render (ver `src/lib/video/generate.ts`).

## Biblioteca de música: bucket privado + URL firmada bajo demanda, nunca una URL guardada

`MUSIC_MANIFEST` guarda `storagePath` (una ruta dentro del bucket
`music-library`), no una URL — ni pública ni firmada de antemano. Se
evaluaron dos opciones para que el pipeline pueda descargar la pista sin
exponerla al usuario ni redistribuirla de forma independiente:

- **Elegida**: bucket privado sin ninguna policy pública + una URL firmada
  de máximo 1 hora, generada en el momento exacto del render, solo en
  código de servidor (`src/lib/providers/music/storage.ts`,
  `createServiceClient()`) — mismo patrón que `getSignedVideoUrl`
  (`src/lib/storage/signed-url.ts`) para el video final. Nada queda
  "horneado" en el código fuente con acceso de larga vida.
- **Descartada**: generar manualmente una URL firmada de larga duración y
  pegarla directamente en el manifest (funciona sin tocar código, pero esa
  URL es efectivamente una credencial de acceso permanente guardada en el
  repositorio — más débil si el repo cambia de visibilidad algún día).

Errores tipados nuevos (`MusicObjectNotFoundError`, `MusicSigningError`,
en `errors.ts`) distinguen "el objeto no existe en el bucket" de "Supabase
no pudo firmar la URL" — cualquiera de los dos cae en el mismo fallback ya
existente ("video sin música"), pero con una causa exacta en logs.

## Primeras pistas reales del banco de música

`MUSIC_MANIFEST` deja de estar vacío con las dos primeras pistas, ambas
verificadas directamente por el usuario en Pixabay Music (este entorno no
tiene salida de red hacia Pixabay — ver limitación documentada en turnos
anteriores) y subidas manualmente al bucket privado `music-library`
(creado por el usuario: Public bucket desactivado, sin policies
públicas). Registro de la verificación, tal como la confirmó el usuario el
2026-09-15:

- **"Upbeat Corporate Inspiring"** — autor/perfil de Pixabay: AudioCoffee.
  Duración 2:25. Licencia: Pixabay Content License.
  `https://pixabay.com/music/upbeat-upbeat-corporate-inspiring-335162/`.
  La página sugiere además el crédito **"Music by Denys Kyshchuk from
  Pixabay."** — distinto del perfil/cuenta uploader (AudioCoffee). El tipo
  `MusicTrackEntry` no tiene hoy un campo dedicado para una línea de
  atribución sugerida además de `author`; se documentó como comentario en
  `manifest.ts` en vez de ampliar el esquema sin autorización (instrucción
  explícita del usuario: reportarlo como pendiente antes de tocar el
  modelo). Si más adelante se agrega un campo `suggestedCredit?: string`
  (opcional, no rompe las entradas existentes, no requiere migración de
  base de datos porque `MUSIC_MANIFEST` vive en código), este es el primer
  caso real que lo justificaría.
- **"Instrumental music - powerful, motivational"** — autor: Huynhhoa89.
  Duración 2:25. Licencia: Pixabay Content License.
  `https://pixabay.com/music/build-up-scenes-instrumental-music-powerful-motivational-266030/`.
  Sin crédito sugerido adicional reportado.

Tonos asignados (ver `tone.ts`) tal como los propuso una sesión anterior y
el usuario confirmó sin cambios: la primera con `corporate`,
`motivational`, `technology`; la segunda con `motivational`, `energetic`,
`cinematic` — los seis valores pertenecen al tipo `MusicTone`.

## Qué se dejó fuera del MVP a propósito

- **Cancelar un render en curso**: el enunciado lo marcaba como "si
  aplica". Se decidió no implementarlo — agregaría una API nueva, un botón
  nuevo y un camino de cancelación en el workflow de GitHub Actions por un
  beneficio bajo en un MVP con pocos usuarios concurrentes. El timeout de
  15 minutos + reintento ya cubre el caso real (un render colgado).
- **Cron/reaper activo para renders colgados**: se prefirió detectar el
  timeout de forma perezosa (al intentar un nuevo render) en vez de un job
  programado — un cron en GitHub Actions no corre confiablemente en repos
  privados gratuitos (ver investigación de límites en el README), y
  agregar un cron en Vercel sería infraestructura nueva para un caso raro.
- **Auto-publicación a redes sociales**: explícitamente fuera de alcance
  por instrucción del usuario.
