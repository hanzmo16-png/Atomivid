# Atomivid

Plataforma SaaS para generar reels "faceless" con IA. Este repo está en el
**Paso 1** del plan: registro/login de usuarios y un formulario que guarda la
solicitud de video en la base de datos (todavía sin generación de contenido).

## Stack

- **Next.js 15** (App Router, TypeScript, Tailwind CSS)
- **Supabase** para autenticación (email/contraseña) y base de datos (Postgres)

## Qué incluye este Paso 1

- Registro e inicio de sesión con Supabase Auth (confirmación por correo).
- Rutas protegidas (`/dashboard/*`) mediante middleware de sesión.
- Formulario en `/dashboard/new` con tema, estilo/tono y duración deseada,
  que guarda la solicitud en la tabla `video_requests` con estado `pending`.
- `/dashboard` muestra el historial de solicitudes del usuario.
- **Todavía no genera video real** (guion, voz, footage, subtítulos, render):
  eso es el Paso 2.

## Configuración

### 1. Crear proyecto en Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. En **Project Settings → API** copia la `Project URL` y la `anon public key`.
3. En **Authentication → Providers**, deja habilitado el proveedor de Email.
   Si quieres confirmar cuentas por correo (recomendado), déjalo activado en
   **Authentication → Emails**.
4. En **Authentication → URL Configuration**, agrega como *Redirect URL*:
   - `http://localhost:3000/auth/callback` (desarrollo)
   - `https://tu-dominio.com/auth/callback` (producción, cuando aplique)

### 2. Ejecutar la migración de base de datos

En **SQL Editor** de Supabase, ejecuta el contenido de
`supabase/migrations/0001_init.sql`. Esto crea la tabla `video_requests` con
Row Level Security, de modo que cada usuario solo puede ver y crear sus
propias solicitudes.

Si usas la [CLI de Supabase](https://supabase.com/docs/guides/cli), puedes
en su lugar correr:

```bash
supabase link --project-ref <tu-project-ref>
supabase db push
```

### 3. Variables de entorno

Copia `.env.example` a `.env.local` y completa con los valores del paso 1:

```bash
cp .env.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu-anon-key
```

### 4. Instalar dependencias y correr en desarrollo

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000). Crea una cuenta, confirma
tu correo (si la confirmación por email está activada) e inicia sesión para
llegar al dashboard y crear una solicitud de video.

## Próximos pasos

- **Paso 2**: integrar generación de guion (LLM), voz (texto a voz), footage
  y ensamblado final con Remotion, actualizando el `status` y `video_url` de
  cada `video_request`.
- **Paso 3**: integrar Stripe para suscripción mensual y limitar la
  generación según el plan del usuario.
