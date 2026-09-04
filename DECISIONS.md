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
