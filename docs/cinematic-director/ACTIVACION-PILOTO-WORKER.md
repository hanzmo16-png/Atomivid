# Director en el worker de Reels: piloto, activación y reversión (chatgpt-06)

Estado al entregar: **todo apagado**. Este cambio no activa nada por sí solo.

## Recorrido real app → dispatch → checkout → worker → Director

1. **App (Vercel)** — `POST /api/generate/[id]/render` (`src/app/api/generate/[id]/render/route.ts`) valida dueño, intentos, cuota y suministro, pasa la solicitud a `processing` y llama a `getRenderWorker().trigger(...)`.
2. **Dispatch** — `src/lib/worker/github-actions.ts` envía `repository_dispatch` `render-video` con `client_payload = { requestId, renderAttempt, mode }`. **No lleva ningún campo del Director ni una rama/ref**, y este cambio no los añade.
3. **Checkout** — `.github/workflows/render.yml` usa `actions/checkout@v4` sin `ref`. Para `repository_dispatch`, GitHub ejecuta el workflow **de la rama por defecto** y hace checkout de su último commit. Por eso el worker de producción solo ejecuta el Director cuando este código está en la rama por defecto.
4. **Worker** — `scripts/render-worker.ts` → `runRenderJob` (`src/lib/video/run-job.ts`). El worker relee la fila `video_requests` (modo, narración grabada, dueño) y, solo si es un Reel visual, llama a `resolveDirectorRender` (`src/lib/video/director/render-access.ts`). Esa función:
   - consulta la cuenta dueña con `auth.admin.getUserById` únicamente si el interruptor global está encendido;
   - devuelve `true` solo con `CINEMATIC_DIRECTOR_RENDER_ENABLED` encendido, cuenta con correo confirmado en `CINEMATIC_DIRECTOR_PILOT_EMAILS` y Reel visual sin narración grabada;
   - si la consulta de la cuenta falla, se queda con el montaje clásico.
   El worker registra `[atomivid:director] {requestId, directorRender}`, sin correos.
5. **Director** — `generateVideoFromScript({ ..., directorRender })` (`src/lib/video/generate-video.ts`) monta con `reel-render` solo si `directorRender && cinematicDirectorRenderEnabled()`. Cualquier otro llamador (scripts, pruebas) queda en `false` por defecto. Si el plan no se puede montar honestamente, el render se detiene con un error explícito (comportamiento ya cerrado en PR #106). Para entonces la voz ya se pagó y el intento cuenta para el máximo de 3.

Avatar y Long Form nunca entran: `run-job.ts` solo decide para `mode === "visual"`, `render-access.ts` vuelve a exigirlo y `render.yml` no pasa las variables cuando `mode == 'long_form'`.

## Controles

| Dónde | Nombre | Tipo | Efecto |
|---|---|---|---|
| GitHub (repo) | `CINEMATIC_DIRECTOR_RENDER_ENABLED` | **Variable** del repositorio (`1`) | Interruptor global del montaje en el worker |
| GitHub (repo) | `CINEMATIC_DIRECTOR_PILOT_EMAILS` | **Secret** (lista separada por comas) | Cuentas piloto para el montaje. Vacío = nadie |
| Vercel (Production) | `CINEMATIC_DIRECTOR_V2_ENABLED` | Env | Panel de inspección en la revisión (solo lectura) |
| Vercel (Production) | `CINEMATIC_DIRECTOR_PILOT_EMAILS` | Env (sensitive) | Mismas cuentas para el panel de inspección |
| Vercel (Production) | `CINEMATIC_DIRECTOR_RENDER_ENABLED` | Env | Hace que el panel diga la verdad («el plan dirige el montaje») y muestra el panel de recetas aplicadas en la página del video |

Inspección (Vercel) y montaje (worker) son independientes. Encender solo Vercel **no** cambia el render.

## Activación (no ejecutada; requiere decisión expresa de Hans)

1. Revisar y fusionar PR #106 junto con este commit en la rama por defecto. Vercel desplegará con todo apagado; sin las variables, el comportamiento es idéntico al actual.
2. En GitHub → Settings → Secrets and variables → Actions:
   - crear el secret `CINEMATIC_DIRECTOR_PILOT_EMAILS` con el correo confirmado de Hans;
   - crear la variable `CINEMATIC_DIRECTOR_RENDER_ENABLED=1`.
3. Opcional para ver el panel: en Vercel Production poner `CINEMATIC_DIRECTOR_V2_ENABLED=1`, `CINEMATIC_DIRECTOR_RENDER_ENABLED=1` y `CINEMATIC_DIRECTOR_PILOT_EMAILS` (mismo correo), y volver a desplegar.
4. Piloto: Hans crea un Reel de 30 s, genera el guion una vez y pulsa «Generar video final» una vez.
   - Verificar en el log del run `render-video` la línea `[atomivid:director] ... "directorRender":true`.
   - Verificar `director.json` junto al `final.mp4`.
   - Una solicitud de otra cuenta debe registrar `"directorRender":false`.

### Antes de fusionar

- Un preview de Vercel del PR **no** prueba esto: su dispatch va al mismo repositorio y el worker ejecuta la rama por defecto, sin este código.
- La única forma de ejecutar el worker de la rama antes de fusionar es `workflow_dispatch` manual con `--ref <rama>` y un `request_id` real. Eso usa los secretos y la base de producción y paga voz/render, así que requiere autorización expresa de gasto. No se hizo.

## Reversión

- **Inmediata, sin desplegar:** borrar la variable `CINEMATIC_DIRECTOR_RENDER_ENABLED` del repositorio (o ponerla a `0`), o vaciar el secret `CINEMATIC_DIRECTOR_PILOT_EMAILS`. El siguiente dispatch vuelve al montaje clásico. Un run ya en curso termina con la configuración con la que empezó.
- **Panel:** quitar `CINEMATIC_DIRECTOR_V2_ENABLED` en Vercel y volver a desplegar.
- **Código:** revertir el commit; sin migraciones ni datos que deshacer.
