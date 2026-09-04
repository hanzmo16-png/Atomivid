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

Si usas la [CLI de Supabase](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <tu-project-ref>
supabase db push
```

### 3. Crear cuentas en las APIs de generación (opcional para probar)

- **Anthropic (Claude)**: [console.anthropic.com](https://console.anthropic.com).
- **ElevenLabs**: [elevenlabs.io](https://elevenlabs.io) (capa gratuita limitada).
- **Pexels**: [pexels.com/api](https://www.pexels.com/api) (gratis).
- **Música de fondo**: no hay banco gratuito con API key integrado todavía
  (ver "Limitaciones"). Deja `MUSIC_TRACK_URL` vacío para usar el fixture, o
  apunta a una pista propia con licencia verificada.

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
| Música | Pista propia vía `MUSIC_TRACK_URL` | Tono suave generado (WAV) | `MUSIC_PROVIDER` |
| Render | Remotion (Chromium + FFmpeg interno) | — (siempre real) | — |

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
- **Música de fondo**: sin costo — todavía no hay integración con un banco
  de pago ni gratuito, ver limitaciones.

## Limitaciones actuales

- **Música de fondo**: no hay un banco gratuito con API key conectado
  todavía (Pixabay Music/Freesound requieren cuenta + credenciales que no
  se han configurado). El proveedor fixture genera un tono suave, no música
  real con licencia. Hace falta que el usuario provea `MUSIC_TRACK_URL` o
  se conecte un banco real — **requiere autorización antes de contratarlo
  si implica un plan de pago.**
- **Render dentro de la request HTTP**: `/api/generate/[id]/render` corre el
  resto del pipeline (voz/footage/música/render) de forma síncrona
  (`maxDuration = 300`). En Vercel esto requiere un plan que soporte
  funciones de larga duración. Recomendado a futuro: mover el render a un
  worker/cola en background. La generación del guion (`/script`) es rápida
  y no tiene este problema.
- **Sin progreso por etapas dentro del render**: una vez que se pulsa
  "Generar video final", el historial muestra `processing` sin detalle de
  en qué etapa interna (voz/footage/música/render) va — sí hay progreso
  explícito para la etapa de guion (`pending` → `script_ready`).
- **Pagos fallidos**: el estado `past_due`/`unpaid` ya bloquea la
  generación, pero no hay notificación proactiva al usuario
  (`invoice.payment_failed`).
- **Entorno de desarrollo de este agente**: esta sesión de Claude Code corre
  en un entorno con salida de red restringida (solo `api.anthropic.com` y
  registros de paquetes) — por eso las pruebas aquí usan los proveedores
  fixture; el pipeline real con Supabase/ElevenLabs/Pexels/Stripe solo se
  puede probar en producción (Vercel) o en una máquina con salida de red
  normal.

## Completado / pendiente

**Completado y probado:**
- Registro/login, rutas protegidas, formulario de solicitud.
- Suscripción de pago con Stripe (checkout, portal, webhook, cuota mensual).
- Pipeline completo con patrón de adaptadores + fixtures (`npm run test:pipeline`,
  verificado con `ffprobe`: H.264 1080×1920 @30fps, audio AAC, crossfade,
  subtítulos por frase, música mezclada).
- Editor/revisión de guion (`/dashboard/review/[id]`): editar texto y
  búsqueda visual por escena, regenerar una escena individual, guardar
  cambios, y recién entonces generar el video final — probado end-to-end
  con `npm run test:pipeline` (incluye una regeneración de escena real
  antes del render).
- Build de producción y lint sin errores.

**Pendiente:**
- Conectar un banco de música real (requiere tu autorización si implica pago).
- Progreso por etapas dentro del render (voz/footage/música/render).
- Mover el render a un worker/cola en background.
- Probar el pipeline real (Claude/ElevenLabs/Pexels/Stripe) en producción —
  bloqueado en este entorno por la restricción de red descrita arriba.

## Despliegue

1. Sube el repo a GitHub y conéctalo en [vercel.com](https://vercel.com)
   ("Add New Project" → importar repo).
2. Agrega todas las variables de `.env.example` en Vercel (Project →
   Settings → Environment Variables).
3. Ajusta `NEXT_PUBLIC_SITE_URL` a tu dominio de Vercel y agrega
   `<tu-dominio>/auth/callback` como Redirect URL en Supabase.
4. Configura el webhook de Stripe apuntando a
   `https://<tu-dominio>/api/stripe/webhook`.
5. Redeploy.

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

1. Conectar un banco de música real (con tu autorización).
2. Progreso por etapas dentro del render (voz/footage/música/render).
3. Mover el render a un worker/cola en background.
4. Auto-publicación a redes sociales (fuera del alcance del MVP).
