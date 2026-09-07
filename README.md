# Atomivid

Plataforma SaaS para generar reels "faceless" verticales (9:16), listos para
TikTok/Instagram Reels/YouTube Shorts, a partir de un tema escrito por el
usuario. El pipeline genera guion → voz → footage → música → subtítulos →
ensamblado → render, con autenticación y suscripción de pago.

## Qué hace Atomivid

1. El usuario escribe un tema, elige estilo/tono y duración.
2. Se genera un guion dividido en escenas (título + narración + búsqueda
   visual por escena).
3. Se sintetiza la narración completa con timestamps por palabra.
4. Se busca una imagen por escena a partir de esa narración.
5. Se agrega música de fondo por debajo de la narración.
6. Se generan subtítulos incrustados agrupados por frase natural (nunca una
   palabra sola a la vez).
7. Se ensambla el video final: formato vertical 1080×1920, efecto Ken Burns
   sobre cada imagen y **crossfade** entre escenas (no son cortes secos).
8. El usuario ve, reproduce y descarga el resultado desde su historial.

## Arquitectura

- **Frontend + backend**: Next.js 16 (App Router, TypeScript), Tailwind CSS.
- **Auth + base de datos + storage**: Supabase (Postgres, Auth, Storage).
- **Pagos**: Stripe (suscripción mensual, restringe la generación).
- **Motor de composición**: Remotion — renderiza el MP4 final (usa FFmpeg
  internamente para la codificación H.264/AAC). Se evaluó reescribir el
  ensamblado en FFmpeg puro, pero Remotion ya cumple "motor de composición
  modular", ya está integrado y verificado end-to-end en este repo — hacerlo
  de nuevo en FFmpeg crudo habría sido un retroceso sin beneficio real.
- **Pipeline modular por adaptadores** (`src/lib/providers/`): cada etapa
  (guion, voz, footage, música) tiene una interfaz común con dos
  implementaciones intercambiables:
  - **Real**: llama a la API externa (Claude, ElevenLabs, Pexels).
  - **Fixture**: determinística, sin red ni claves — genera texto templado,
    un tono de audio (WAV generado en JS puro) y una imagen de color sólido.
    Permite probar el flujo completo (`npm run test:pipeline`) sin gastar
    nada ni depender de conectividad externa.

  La selección de proveedor se auto-detecta por variable de entorno: si
  falta la API key correspondiente, usa el fixture automáticamente (ver
  `.env.example`).

```
Tema → Guion (adapter) → Voz (adapter) → Escenas alineadas a la narración
     → Footage por escena (adapter) → Música de fondo (adapter)
     → Subtítulos por frase → Render (Remotion) → Storage → Historial
```

## Requisitos

- Node.js 20+ y npm.
- Una cuenta de Supabase (gratis).
- Para producción real: cuentas de Anthropic, ElevenLabs, Pexels y Stripe
  (todas tienen capa gratuita o modo de prueba). Sin ellas, el pipeline
  funciona igual con los proveedores fixture.

## Instalación

```bash
git clone <url-del-repo>
cd atomivid
npm install
cp .env.example .env.local
```

### 1. Crear proyecto en Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. En **Project Settings → API** copia `Project URL`, `anon public key` y
   `service_role key` (esta última es secreta — nunca la expongas al cliente).
3. En **Authentication → Providers**, deja habilitado el proveedor de Email.
4. En **Authentication → URL Configuration**, agrega como *Redirect URL*:
   - `http://localhost:3000/auth/callback` (desarrollo)
   - `https://tu-dominio.com/auth/callback` (producción, cuando aplique)

### 2. Ejecutar las migraciones de base de datos

En **SQL Editor** de Supabase, ejecuta en orden:

1. `supabase/migrations/0001_init.sql` — tabla `video_requests` con Row Level
   Security (cada usuario solo ve/crea sus propias solicitudes).
2. `supabase/migrations/0002_generation.sql` — columna `error_message` y el
   bucket de Storage `videos` (lectura pública, escritura solo desde el
   backend con la service role key).
3. `supabase/migrations/0003_billing.sql` — tabla `subscriptions` (una fila
   por usuario, RLS de solo lectura; las escrituras las hace el backend con
   la service role key).
4. `supabase/migrations/0004_script_review.sql` — columna `script_json` y el
   estado `script_ready`, para el editor de guion antes del render final.
5. `supabase/migrations/0005_render_progress.sql` — columna `progress_stage`,
   para mostrar en qué parte del render va una generación en curso.
6. `supabase/migrations/0006_render_worker.sql` — columnas para el worker en
   background (`render_attempts`, `render_started_at`, `render_worker`,
   `video_path`) y **cambia el bucket `videos` de público a privado**
   (las URLs ahora se firman bajo demanda — ver "Worker en background").
   Si ya habías generado algún video de prueba con la URL pública
   anterior, esa URL deja de funcionar; no hay pérdida de datos, solo de
   ese enlace.
7. `supabase/migrations/0007_input_limits.sql` — topes de longitud/duración
   en `video_requests` (defensa en profundidad para no permitir una
   solicitud que dispare un gasto desproporcionado).

Si usas la [CLI de Supabase](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <tu-project-ref>
supabase db push
```

### 3. Crear cuentas en las APIs de generación (opcional para probar)

- **Anthropic (Claude)**: [console.anthropic.com](https://console.anthropic.com).
- **ElevenLabs**: [elevenlabs.io](https://elevenlabs.io) (capa gratuita limitada).
- **Pexels**: [pexels.com/api](https://www.pexels.com/api) (gratis).
- **Música de fondo**: no hay una API en vivo conectada (ver "Música de
  fondo" abajo — ni Pixabay Music ni Freesound ofrecen hoy una API lista
  para uso comercial gratis sin pasos extra). Deja `MUSIC_TRACK_URL(S)`
  vacío para usar el fixture, o sigue esa sección para curar pistas reales
  gratis.

Si no configuras alguna de estas, esa etapa usa su proveedor fixture
automáticamente — el pipeline completo sigue funcionando.

### 4. Configurar Stripe

1. Crea una cuenta en [dashboard.stripe.com](https://dashboard.stripe.com)
   (usa el modo *Test* mientras desarrollas).
2. En **Product catalog**, crea un producto (p. ej. "Atomivid Pro") con un
   precio **recurrente mensual**. Copia el `Price ID` (`price_...`) a
   `STRIPE_PRICE_ID`.
3. En **Developers → API keys**, copia la `Secret key` a `STRIPE_SECRET_KEY`.
4. Configura el webhook:
   - **En local**: instala la [Stripe CLI](https://stripe.com/docs/stripe-cli)
     y corre `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
     Te da un `whsec_...` — cópialo a `STRIPE_WEBHOOK_SECRET`.
   - **En producción**: en **Developers → Webhooks**, agrega un endpoint a
     `https://tu-dominio.com/api/stripe/webhook` escuchando al menos
     `checkout.session.completed`, `customer.subscription.updated` y
     `customer.subscription.deleted`. Copia su *Signing secret* a
     `STRIPE_WEBHOOK_SECRET`.

## Cómo ejecutar el proyecto

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000), crea una cuenta,
confirma tu correo e inicia sesión.

## Cómo generar un video

1. En "Nuevo video" guarda una solicitud (tema, estilo, duración).
2. Suscríbete desde "Facturación" (tarjeta de prueba `4242 4242 4242 4242`,
   con `stripe listen` corriendo en paralelo si estás en local).
3. En el historial, pulsa "Generar guion". Te lleva a la pantalla de
   revisión (`/dashboard/review/[id]`), donde puedes:
   - Editar el texto de narración o la búsqueda visual de cualquier escena.
   - Regenerar una sola escena (sin tocar las demás).
   - Guardar los cambios.
4. Cuando el guion te convenza, pulsa "Generar video final". Ahí sí corre el
   resto del pipeline (voz, footage, música, render) dentro de la misma
   request HTTP (ver limitaciones), y al terminar podrás reproducir y
   descargar el resultado desde el historial.

### Probar el pipeline sin claves (proveedores fixture)

```bash
npm run test:pipeline
```

Corre el pipeline completo (guion "LOS RESULTADOS TIENEN UN PRECIO" con
~15 escenas, voz, footage, música y render) con los proveedores fixture, sin
red ni claves, y deja el resultado en `scripts/atomivid-test-output.mp4`
(no se sube al repo). Útil para verificar que la composición y el render
funcionan antes de gastar en APIs reales.

## Proveedores integrados

| Etapa | Real | Fixture (sin claves) | Variable de selección |
|---|---|---|---|
| Guion | Claude (Anthropic), salida estructurada | Texto templado en español | `SCRIPT_PROVIDER` |
| Voz | ElevenLabs, con timestamps por palabra | Tono generado (WAV) + timestamps sintéticos | `VOICE_PROVIDER` |
| Footage | Pexels (fotos) | Imagen de color sólido con el texto de búsqueda | `FOOTAGE_PROVIDER` |
| Música | Playlist propia vía `MUSIC_TRACK_URL(S)` | Tono suave generado (WAV) | `MUSIC_PROVIDER` |
| Render | Remotion (Chromium + FFmpeg interno) | — (siempre real) | — |

## Música de fondo: investigación Pixabay Music / Freesound

Investigado antes de conectar nada (sin gastar ni contratar):

- **Pixabay Music**: el contenido (imágenes, video **y música**) se
  publica bajo la Pixabay Content License, que permite uso comercial sin
  atribución obligatoria — es decir, sí es legal y gratis usar sus pistas
  en Atomivid. **Pero** la API pública documentada de Pixabay
  (`pixabay.com/api/docs`) solo cubre imágenes y video; no tiene un
  endpoint de audio/música. No hay forma de buscar/descargar música por
  API con solo crear una cuenta — habría que descargar pistas manualmente
  desde el sitio.
- **Freesound**: la API sí tiene endpoint de audio y la API key es
  instantánea (cuenta gratis en freesound.org → apply). Pero su uso
  gratuito está limitado a fines **no comerciales**; para uso comercial
  (nuestro caso) hay que escribirles a `mtg@upf.edu` para acordar
  licencia — no es autocontratable ni está garantizado que sea gratis.
- **Conclusión**: ninguna de las dos da hoy "solo crea cuenta/API key y ya
  puedes usarla en producción" para un SaaS comercial. La solución sin
  costo y sin bloquear nada: descargar manualmente 10-20 pistas de Pixabay
  Music (licencia comercial gratuita confirmada) o de
  [Mixkit](https://mixkit.co/free-stock-music/) (también gratis para uso
  comercial, sin cuenta), subirlas a un bucket propio (p. ej. Supabase
  Storage) y configurar `MUSIC_TRACK_URLS` con la lista separada por comas
  — el proveedor `custom-url` ahora elige una al azar por video en vez de
  repetir siempre la misma. Esto no requiere ninguna credencial nueva ni
  gasto; solo curaduría manual de pistas (paso que le corresponde al
  usuario, ya que implica elegir el estilo musical del producto).

## Música de fondo: banco inicial (pendiente de que cures las pistas)

El tono genérico del proveedor fixture (un pad de dos tonos) es **solo
para pruebas internas** — `scripts/render-worker.ts` (el worker de GitHub
Actions) se niega a correr si la música resuelve a "fixture", precisamente
para que nunca le llegue a un usuario real. Antes de invitar usuarios
reales hace falta curar un banco mínimo. Yo no puedo hacerlo desde este
entorno (sin salida de red hacia Pixabay/Mixkit), así que aquí están los
pasos exactos:

**Criterios para cada pista (los tres son obligatorios):**
1. Licencia explícita de uso comercial gratuito — Pixabay Content License
   o Mixkit Free License son las dos verificadas en la investigación de
   arriba. Si dudas de la licencia de una pista, no la uses.
2. Instrumental (sin voz) — para no competir con la narración.
3. Energía pareja/de fondo, no un tema con subidas y bajadas fuertes de
   volumen — tiene que poder mezclarse bajo la voz sin distraer.

**Pasos:**
1. En [Pixabay Music](https://pixabay.com/music/) o
   [Mixkit](https://mixkit.co/free-stock-music/), busca 10-15 pistas que
   cumplan los tres criterios. Cubre varios estilos: al menos 2-3 pistas
   por cada opción del selector de `/dashboard/new` (Motivacional,
   Educativo, Humor, Historias de terror, Curiosidades, Noticias /
   actualidad, Storytelling personal) — no hace falta una pista distinta
   por estilo si una pista "neutra" combina con varios.
2. Descarga el MP3 de cada una y súbelas a un bucket propio de Supabase
   Storage (puede ser el mismo proyecto, en un bucket separado como
   `music-bank`, o cualquier otro hosting propio con URL pública/firmable
   estable) — nunca a este repositorio.
3. Por cada pista, agrega una entrada en
   `src/lib/providers/music/manifest.ts` (`MUSIC_MANIFEST`) con: `id`,
   `title`, `author` (tal como lo indica la página de origen), `sourceUrl`
   (la página exacta de donde la bajaste, para poder verificar la licencia
   después), `license` (el nombre exacto, p. ej. `"Pixabay Content
   License"`), `styleTags` (uno o más de los valores del selector de
   estilo) y `storageUrl` (la URL pública/firmada donde la subiste).
4. Confirma con `npm run test:pipeline` que el pipeline sigue corriendo
   (el manifest se usa automáticamente en cuanto tenga al menos una
   entrada — no hace falta ninguna variable de entorno nueva).

Mientras el manifest esté vacío y no haya `MUSIC_TRACK_URLS` configurada,
`getMusicProvider()` sigue usando el fixture — el worker de GitHub Actions
simplemente rechazará renders reales hasta que completes esto (ver
"Worker en background" arriba), así que no hay riesgo de que un video con
tono de prueba llegue a un usuario por accidente.

## Costos potenciales

Presupuesto disponible: hasta $30,000 MXN, usado solo si una herramienta de
pago resuelve algo que las opciones gratuitas no cubren — no se ha gastado
nada de ese presupuesto todavía.

- **Supabase**: capa gratuita (Auth + Postgres + Storage) suficiente para el MVP.
- **Vercel**: capa gratuita (Hobby) para hosting.
- **Claude**: pago por uso; modelo económico configurable en `.env.example`.
- **ElevenLabs**: capa gratuita limitada, luego pago por caracteres.
- **Pexels**: gratis.
- **Stripe**: sin costo fijo, comisión por transacción.
- **Música de fondo**: sin costo — playlist curada manualmente por el
  usuario desde bancos gratuitos (ver sección de música arriba).

## Worker en background para el render

**Implementado**: `/api/generate/[id]/render` ya no corre el pipeline
dentro de la request HTTP. Ahora:

1. Valida dueño/estado/cuota, marca la solicitud `processing` (con una
   guarda de concurrencia optimista para evitar dos renders del mismo
   video) y responde de inmediato (HTTP 202-equivalente).
2. Dispara `.github/workflows/render.yml` vía la API de "repository
   dispatch" de GitHub (`src/lib/worker/github-actions.ts`).
3. El workflow corre en un runner de GitHub Actions: instala
   dependencias, ejecuta `scripts/render-worker.ts` (que llama al mismo
   `runRenderJob()`/pipeline que usa `npm run test:pipeline`), y actualiza
   `progress_stage`/`status`/`video_path` en Supabase directamente.
4. Si el paso de render falla o se corta por `timeout-minutes: 12`, un
   paso `if: failure()` (`scripts/mark-render-failed.ts`) deja la
   solicitud en `failed` en vez de `processing` para siempre.

Si `GH_WORKER_TOKEN`/`GH_WORKER_REPO` no están configuradas, cae
automáticamente al worker `inline` (corre en el mismo proceso — el
comportamiento síncrono original, útil para desarrollo/pruebas locales;
ver `npm run test:pipeline`).

**Verificado con datos reales (no solo fixtures)**: además de
`npm run test:pipeline` (fixtures, local), el workflow real se disparó
sobre una solicitud real en la base de datos de producción (creada vía
`scripts/seed-test-request.ts`, otro workflow de un solo uso, asociada a
un usuario real de Supabase Auth) y corrió de punta a punta con
credenciales reales: síntesis de voz con ElevenLabs, footage con Pexels,
render con Remotion/Chromium, subida a Supabase Storage. El video
resultante se verificó con `ffprobe` (corrido dentro del runner de GitHub
Actions, ya que este entorno de desarrollo tampoco tiene salida de red
hacia Supabase ni hacia el almacenamiento de artifacts de GitHub):
H.264, 1080×1920, 30fps, audio AAC, ~14MB.

**Lo que sigue sin probarse**: el disparo *automático* desde la app real
(un usuario hace clic en "Generar video final" en Vercel →
`repository_dispatch` vía `GH_WORKER_TOKEN`/`GH_WORKER_REPO`) — lo que se
probó fue el workflow en sí, disparado manualmente
(`workflow_dispatch`) apuntando a una solicitud real. También sigue sin
probarse la generación de guion real con Claude (el guion de la prueba se
generó con el proveedor fixture a propósito, para no necesitar
`ANTHROPIC_API_KEY` en los secrets del workflow — esa etapa corre en
Vercel, no en este worker).

Antes de implementar el workflow se verificó que `repository_dispatch` no
tiene la restricción de `schedule` en repos privados gratuitos (esa
restricción solo afecta a los triggers de cron); el tope real es 2,000
minutos/mes en repos privados y 6h por job — ambos muy por encima de lo
que necesita este MVP.

A continuación, la comparación completa de alternativas que llevó a elegir
GitHub Actions para esta etapa:

| Opción | Costo mínimo/mes | Capa gratuita | Dificultad | Escalabilidad | Compatibilidad |
|---|---|---|---|---|---|
| **GitHub Actions** (dispara un workflow desde la API, corre el render con el mismo Chromium/ffmpeg que ya usa `test:pipeline`, sube a Supabase Storage) | **$0** | 2,000 min/mes gratis en repos privados (ilimitado en públicos) | Media — hay que orquestar: la API dispara el workflow vía GitHub API (token), el workflow corre el render y notifica de vuelta (webhook o polling del estado) | Baja/media — sin cola real, min limitados, latencia extra por arrancar el runner (~10-30s) | Alta — reutiliza el mismo código Node/Remotion/ffmpeg que ya corre en este repo, sin reescribir nada del pipeline |
| **Remotion Lambda (AWS)** | Pago por uso, sin mínimo fijo (AWS Lambda tiene capa gratis perpetua: 400,000 GB-s + 1M requests/mes) | Sí (capa gratis de AWS Lambda) | Media-alta — requiere cuenta AWS, configurar `@remotion/lambda`, S3 para assets/salida; Remotion en sí es gratis para equipos de ≤3 personas (nuestro caso), sin licencia de pago | Muy alta — es el producto oficial de Remotion para esto, pensado para producción | Alta — mismo motor de render que ya usamos, solo cambia dónde corre |
| **Railway** | ~$5-20+/mes reales para un worker persistente | Solo un trial de $5 una vez; después $1 de crédito gratis/mes (no alcanza para un worker que use Chromium) | Baja — despliegue simple tipo Heroku | Media | Alta — es solo un contenedor Node, correría el mismo código |
| **Render.com** | $7/mes (Starter, 512MB/0.5CPU) para un *background worker* | Free tier existe pero es para *web services* que se duermen a los 15 min de inactividad — no apto para un worker persistente que reciba jobs de render (que además necesita más de 512MB con Chromium) | Baja | Media | Alta — mismo modelo, contenedor Node |

**Recomendación objetiva para validar el MVP con pocos usuarios y
presupuesto ajustado**: **GitHub Actions** como worker gratuito para la
fase de validación (cero costo fijo, reutiliza exactamente lo ya construido
y probado en este repo), y dejar **Remotion Lambda** como el camino a
escalar cuando haya usuarios reales pagando — sigue siendo pago por uso
(no una cuota fija mensual) y es la opción diseñada específicamente para
esto por los mismos creadores de Remotion. Railway y Render.com no tienen
ya una capa gratuita real para esta carga de trabajo (Chromium + render de
video), así que solo tendrían sentido si se prefiere algo "siempre
encendido" sin usar GitHub Actions — no se recomienda para esta etapa.
Ninguna de estas dos opciones se ha implementado ni contratado — requiere
tu decisión y, en el caso de Remotion Lambda, una cuenta de AWS con tarjeta
de pago (aunque el uso esperado del MVP caiga dentro de la capa gratuita).

## Limitaciones actuales

- **Música de fondo**: sin pistas reales curadas todavía (ver "Banco
  inicial" arriba). El proveedor fixture genera un tono suave, nunca
  música con licencia real, y el worker de GitHub Actions se niega a
  generar un video real mientras esto siga así — no es un riesgo de que
  llegue al usuario, es un bloqueo pendiente de que cures ~10-15 pistas.
- **Render en segundo plano**: implementado vía GitHub Actions y **verificado
  en producción real** (no solo local): voz con ElevenLabs real, footage
  con Pexels real, render con Remotion/Chromium, y subida a Supabase
  Storage, disparado vía `workflow_dispatch` sobre una solicitud real en la
  base de datos de producción. Video final verificado con `ffprobe` dentro
  del propio runner de GitHub Actions (este entorno de desarrollo no tiene
  salida de red hacia Supabase ni hacia el almacenamiento de artifacts de
  GitHub, así que la verificación no se pudo hacer descargando el archivo
  aquí — se corrió `ffprobe` en el runner y se leyó el resultado de los
  logs): H.264, 1080×1920, 30fps, audio AAC, ~14MB. El disparo automático
  real desde la app (`repository_dispatch` vía `GH_WORKER_TOKEN`/
  `GH_WORKER_REPO` en Vercel) no se probó todavía — lo probado fue el
  workflow en sí, disparado manualmente apuntando a una solicitud real.
- **Pagos fallidos**: el estado `past_due`/`unpaid` ya bloquea la
  generación, pero no hay notificación proactiva al usuario
  (`invoice.payment_failed`).
- **Timeout de render sin cron**: si un render en GitHub Actions se cuelga,
  el propio `timeout-minutes: 12` del job y el paso `if: failure()` lo
  marcan como `failed`. Lo que no hay es un "reaper" activo con cron — un
  render colgado que el runner no llega a matar (caso raro) queda en
  `processing` hasta que el usuario intenta un nuevo render, momento en el
  que la ruta API detecta que pasó `RENDER_TIMEOUT_MS` (15 min) y permite
  reintentar. Aceptable para el volumen de un MVP; un cron sería la mejora
  natural con más usuarios.
- **Entorno de desarrollo de este agente**: esta sesión de Claude Code corre
  en un entorno con salida de red restringida (solo `api.anthropic.com` y
  registros de paquetes) — por eso las pruebas aquí usan los proveedores
  fixture; el pipeline real con Supabase/ElevenLabs/Pexels/Stripe/GitHub
  Actions solo se puede probar en producción (Vercel) o en una máquina con
  salida de red normal.

## Completado / pendiente

**Completado y probado en producción real** (no solo local/fixtures):
- Las 7 migraciones aplicadas en el proyecto real de Supabase.
- Worker en background vía GitHub Actions: probado end-to-end con
  credenciales reales — voz con ElevenLabs, footage con Pexels, render con
  Remotion/Chromium, subida a Supabase Storage. Video final verificado con
  `ffprobe` corrido dentro del runner (H.264, 1080×1920, 30fps, audio AAC,
  ~14MB). Incluye idempotencia (guarda de concurrencia), límite de 3
  reintentos, timeout de 15 min con aviso/reintento en el historial, y el
  paso "marcar como fallido" si el workflow muere — confirmado en la
  práctica (se activó correctamente en los primeros intentos fallidos
  mientras se ajustaban credenciales).
- Storage privado con URLs firmadas: confirmado con la descarga real del
  video de prueba vía `getSignedVideoUrl`.
- Encontrados y corregidos en el camino (todos con commits propios): Node
  20→22 en los workflows (`@supabase/supabase-js` necesita WebSocket
  nativo), voz default "Rachel" ya no es gratuita por API en ElevenLabs
  (cambiada a "Roger", confirmada como voz premade real de la cuenta), y
  CRF de Remotion sin acotar generaba videos más grandes que el límite de
  Supabase Storage (bajado a `crf: 26`).

**Completado y probado localmente (con fixtures):**
- Registro/login, rutas protegidas, formulario de solicitud (con límites
  de tema/estilo/duración validados en servidor, no solo en el `<select>`).
- Suscripción de pago con Stripe (checkout, portal, webhook con verificación
  de firma, cuota mensual) — no probado con una transacción real.
- Pipeline completo con patrón de adaptadores + fixtures (`npm run test:pipeline`,
  verificado con `ffprobe`: H.264 1080×1920 @30fps, audio AAC, crossfade,
  subtítulos por frase, música mezclada, ~97s).
- Editor/revisión de guion (`/dashboard/review/[id]`): editar texto y
  búsqueda visual por escena (con topes de longitud/cantidad de escenas),
  regenerar una escena individual, guardar cambios, y recién entonces
  generar el video final.
- Progreso por etapas dentro del render: el historial muestra en qué parte
  va (voz → footage → música → ensamblado → subiendo).
- Banco de música por estilo (`MUSIC_MANIFEST`) con selección acorde al
  estilo elegido en `/dashboard/new`, compatible con la playlist plana
  anterior (`MUSIC_TRACK_URLS`) — sin pistas reales cargadas todavía.
- Build de producción, lint y verificación de tipos sin errores.

**Pendiente (requiere al usuario o una decisión suya):**
- Curar 10-15 pistas de música reales y llenar `MUSIC_MANIFEST` (paso del
  usuario: implica elegir el estilo musical del producto — instrucciones
  exactas en "Banco inicial" arriba).
- Probar el disparo *automático* real: crear una solicitud desde la app en
  Vercel, generar guion (con Claude real) y pulsar "Generar video final" —
  lo probado hasta ahora fue el workflow disparado manualmente
  (`workflow_dispatch`) sobre una solicitud sembrada directamente en la
  base de datos, no el flujo completo iniciado por un clic real en la UI.
- Probar una transacción real de Stripe (checkout → webhook → estado de
  suscripción reflejado en la app).
- Decidir si escalar a Remotion Lambda cuando haya usuarios de pago (ver
  comparación arriba) — requiere una cuenta de AWS.
- Borrar la solicitud/usuario de prueba que quedaron en la base de datos
  real (tema `"[PRUEBA AUTOMÁTICA] Validación técnica del worker de
  Atomivid"`, usuario con email bajo `atomivid-internal.test`) cuando ya
  no los necesites como referencia.

## Despliegue

1. Sube el repo a GitHub y conéctalo en [vercel.com](https://vercel.com)
   ("Add New Project" → importar repo).
2. Agrega todas las variables de `.env.example` en Vercel (Project →
   Settings → Environment Variables).
3. Ajusta `NEXT_PUBLIC_SITE_URL` a tu dominio de Vercel y agrega
   `<tu-dominio>/auth/callback` como Redirect URL en Supabase.
4. Configura el webhook de Stripe apuntando a
   `https://<tu-dominio>/api/stripe/webhook`.
5. Para el worker de render (ver "Worker en background"):
   - En GitHub → tu repo → **Settings → Secrets and variables → Actions**,
     agrega los secrets que usa `.github/workflows/render.yml`:
     `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ELEVENLABS_API_KEY`,
     `ELEVENLABS_VOICE_ID` (opcional), `ELEVENLABS_MODEL_ID` (opcional),
     `PEXELS_API_KEY`, `MUSIC_TRACK_URLS` (opcional si ya llenaste
     `MUSIC_MANIFEST` en código).
   - En Vercel, agrega `GH_WORKER_TOKEN` (un Personal Access Token de
     GitHub con permiso para disparar workflows en este repo) y
     `GH_WORKER_REPO` (`owner/repo`, p. ej. `tu-usuario/Atomivid`).
6. Redeploy.

## Notas sobre pagos

- El webhook (`/api/stripe/webhook`) es la única fuente de verdad del estado
  de la suscripción — la página de facturación solo lee lo que ya guardó el
  webhook. Si en local no corres `stripe listen`, el checkout se completa en
  Stripe pero la suscripción nunca se refleja en Atomivid.
- La cuota mensual (`MONTHLY_VIDEO_LIMIT`) se cuenta por mes calendario, no
  por ciclo de facturación de Stripe — más simple para el MVP.

## Notas sobre el render de video

- Remotion necesita Chromium para renderizar. Si no configuras
  `REMOTION_BROWSER_EXECUTABLE`, Remotion descarga su propio Chromium la
  primera vez (puede tardar). Si prefieres usar uno ya instalado, apunta esa
  variable al ejecutable y, si es un `chrome-headless-shell` (recomendado en
  Chrome >= 132, que quitó el "old headless mode"), agrega también
  `REMOTION_CHROME_MODE=headless-shell`.
- Costos variables por video: guion (Claude, modelo económico configurable),
  voz (ElevenLabs, modelo turbo de menor costo) y footage (Pexels, gratis).
  Ver `.env.example` para ajustar los modelos usados.

## Próximos pasos

1. Curar manualmente pistas de música gratuitas (Pixabay Music/Mixkit) y
   configurar `MUSIC_TRACK_URLS`/`MUSIC_MANIFEST`.
2. Probar el flujo completo iniciado por un clic real en la app (Vercel):
   crear solicitud → generar guion con Claude real → revisar/editar →
   "Generar video final" → confirmar que dispara el worker real
   (`repository_dispatch`) y que el video aparece en el historial.
3. Probar una transacción real de Stripe (checkout → webhook → estado de
   suscripción reflejado en la app).
4. Decidir si escalar a Remotion Lambda cuando haya usuarios de pago (ver
   comparación arriba) — requiere una cuenta de AWS, con tu autorización.
5. Auto-publicación a redes sociales (fuera del alcance del MVP).

## Qué se verificó en producción real vs. solo localmente

- **Verificado en producción real** (Supabase real, ElevenLabs real,
  Pexels real, GitHub Actions real): las 7 migraciones aplicadas; el
  worker de render completo (voz → footage → música → render → subida →
  video verificado con `ffprobe`); Storage privado con URLs firmadas.
  Disparado manualmente (`workflow_dispatch`) sobre una solicitud sembrada
  directamente en la base de datos — no fue un clic real en la UI de
  Vercel.
- **No verificado todavía**: el disparo automático desde un clic real en
  la app (`/dashboard/review/[id]` → "Generar video final" →
  `repository_dispatch`), la generación de guion real con Claude (la
  prueba usó el proveedor fixture para el guion a propósito), y cualquier
  transacción real de Stripe. El código de estas rutas es el mismo que ya
  se probó en las otras partes del pipeline, pero el camino específico
  "clic del usuario → Vercel → GitHub Actions" en sí no se ejercitó.
- Este entorno de Claude Code no tiene salida de red hacia Vercel,
  Supabase, ElevenLabs, Pexels, Stripe ni el almacenamiento de artifacts
  de GitHub (solo hacia `api.anthropic.com`, registros de paquetes, y la
  API de GitHub a través del conector MCP de este chat) — por eso la
  verificación del render real se hizo disparando workflows de GitHub
  Actions y leyendo sus logs, en vez de probar la app directamente.
