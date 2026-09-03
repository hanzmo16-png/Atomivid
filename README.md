# Atomivid

Plataforma SaaS para generar reels "faceless" con IA. Este repo cubre el
**Paso 1** (registro/login + formulario de solicitud) y el **Paso 2**
(generación automática del video: guion, voz, footage, subtítulos y
ensamblado final). Falta el **Paso 3**: pagos con Stripe.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind CSS)
- **Supabase** — autenticación (email/contraseña), base de datos (Postgres) y
  Storage (assets + video final)
- **Claude (Anthropic)** — generación del guion
- **ElevenLabs** — voz narrada con timestamps por palabra
- **Pexels** — banco gratuito de imágenes de apoyo
- **Remotion** — ensamblado del video final (Ken Burns + subtítulos incrustados)

## Qué incluye

**Paso 1**

- Registro e inicio de sesión con Supabase Auth (confirmación por correo).
- Rutas protegidas (`/dashboard/*`) mediante proxy de sesión.
- Formulario en `/dashboard/new` con tema, estilo/tono y duración deseada,
  que guarda la solicitud en la tabla `video_requests`.
- `/dashboard` muestra el historial de solicitudes del usuario.

**Paso 2**

- Botón "Generar video" en cada solicitud `pending` que dispara
  `POST /api/generate/[id]`, el cual:
  1. Genera el guion (título + escenas con narración y búsqueda visual) con
     **Claude**, usando salida estructurada (JSON validado con Zod).
  2. Sintetiza la narración completa con **ElevenLabs** (una sola llamada,
     con alineación por palabra para los subtítulos).
  3. Reparte el tiempo real de la narración entre las escenas y busca una
     imagen por escena en **Pexels**.
  4. Sube imágenes y audio a Supabase Storage (bucket `videos`).
  5. Renderiza el video final (formato vertical 1080×1920) con **Remotion**:
     efecto Ken Burns sobre cada imagen + subtítulos incrustados en sincronía
     con la voz.
  6. Sube el `.mp4` final a Storage y actualiza `video_requests` con
     `status = completed` y `video_url`.
- El historial muestra el estado (`pending` / `processing` / `completed` /
  `failed`, con reintento) y reproduce/descarga el video una vez listo.

## Configuración

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

Si usas la [CLI de Supabase](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <tu-project-ref>
supabase db push
```

### 3. Crear cuentas en las APIs de generación

- **Anthropic (Claude)**: crea una API key en [console.anthropic.com](https://console.anthropic.com).
- **ElevenLabs**: crea una API key en [elevenlabs.io](https://elevenlabs.io)
  (tiene capa gratuita limitada, suficiente para probar).
- **Pexels**: crea una API key gratuita en [pexels.com/api](https://www.pexels.com/api).

### 4. Variables de entorno

```bash
cp .env.example .env.local
```

Completa `.env.local` con los valores de Supabase y de cada API (ver
comentarios en `.env.example`). Nada de esto se sube al repo — `.env*` está
en `.gitignore`.

### 5. Instalar dependencias y correr en desarrollo

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000), crea una cuenta,
confirma tu correo e inicia sesión. En "Nuevo video" guarda una solicitud y
en el historial pulsa "Generar video".

## Notas sobre el render de video

- Remotion necesita Chromium para renderizar. Si no configuras
  `REMOTION_BROWSER_EXECUTABLE`, Remotion descarga su propio Chromium la
  primera vez (puede tardar). Si prefieres usar uno ya instalado, apunta esa
  variable al ejecutable y, si es un `chrome-headless-shell` (recomendado en
  Chrome >= 132, que quitó el "old headless mode"), agrega también
  `REMOTION_CHROME_MODE=headless-shell`.
- El render (bundling + Chromium + codificación) puede tardar más que una
  función serverless típica. La ruta `/api/generate/[id]` declara
  `maxDuration = 300`, pero en Vercel esto requiere un plan que soporte
  funciones de larga duración. Para producción real, lo recomendable es
  mover el render a un worker o cola dedicados (p. ej. un pequeño servicio
  en background, o `@remotion/lambda`) en vez de bloquear una función HTTP.
- Costos variables por video: guion (Claude, modelo económico configurable),
  voz (ElevenLabs, modelo turbo de menor costo) y footage (Pexels, gratis).
  Ver `.env.example` para ajustar los modelos usados.

## Próximos pasos

- **Paso 3**: integrar Stripe para suscripción mensual y restringir la
  generación de videos según el plan del usuario.
- Mover el render de Remotion a un worker/cola en background en vez de
  ejecutarlo dentro de la request HTTP.
- Auto-publicación a redes sociales (fuera del alcance del MVP).
