# Cliente misterioso (Mystery Shopper AI 2.0)

Módulo del Command Center (`/dashboard/command-center#mystery-shopper`). Solo lo ven el dueño y los administradores.

La versión 1.0 la construyó Grok (PR #310). Claude la continúa en la rama `claude/mystery-shopper-2-20261123` y conserva sus piezas válidas: catálogo, perfiles, medición de archivos con ffprobe/ffmpeg y el cerrojo del modo real.

## Qué hace

Pulsas **PROBAR MI PLATAFORMA**. A partir de ahí:

1. La API crea un trabajo con un id fijado antes de enviar. La creación es atómica, así que un doble clic, dos solicitudes simultáneas o un reintento de red no crean un segundo trabajo.
2. La API pide el worker a GitHub Actions con `repository_dispatch: mystery-shopper-run`, usando el mismo `GH_WORKER_TOKEN` que el worker de video.
3. El worker (`scripts/mystery-shopper/worker.ts`) toma el trabajo con un claim atómico y arranca un navegador y un contexto nuevos, sin cookies. Anota el id de sesión y la versión del navegador.
4. Entra a ATOMIVID con la cuenta QA de los secretos y recorre la misión como el perfil elegido:
   - **principiante:** 412×915;
   - **impaciente:** 390×844, con doble clic y botones atrás/adelante;
   - **creador:** 1366×900;
   - **profesional:** 1440×900.

   Como haría un cliente, omite el recorrido de bienvenida si lo encuentra, y lo anota como hallazgo.
5. Guarda en el trabajo una captura por paso, el registro de acciones y el informe.
6. El panel consulta el trabajo cada 4 s y muestra en palabras sencillas qué hizo, qué encontró, qué funcionó, qué falló, qué simplificar y qué necesita autorización.

No se devuelve ningún recorrido grabado. Si el worker no corre, la evaluación queda «En cola» y así se muestra.

## Dónde se guarda (sin /tmp, sin migraciones)

Todo se guarda en el bucket privado existente `videos`, bajo el prefijo `mystery-shopper/v2/runs/<id>/`. Es el mismo patrón que usa Audio Podcast Studio.

| Archivo | Qué contiene |
|---|---|
| `job.json` | La solicitud, que no cambia. Se crea con `upsert:false`: el 409 de Storage es la reserva atómica. |
| `claim-<n>.json` | El worker que tiene el intento n. Se crea igual, así que solo un worker gana cada intento. |
| `status.json` | Estado, etapa, latido cada 30 s, navegador y resumen del veredicto. Solo lo escribe el dueño del claim vigente. |
| `report.json` | El informe final. Inmutable. |
| `evidence/*` | Capturas y `actions.log`. Inmutables. |
| `dispatch-<n>[-ok\|-fail].json` | Despachos pedidos y su resultado. Máximo 3 por trabajo. |

Cómo se recupera un worker caído: si pasan 10 minutos sin latido, otro worker toma el intento siguiente. El máximo es de 3 intentos, y después el trabajo queda en error. Si el worker falla, el trabajo queda en «error» con el motivo; nunca se queda «en proceso» para siempre.

## Disparo automático

Cuando el CI está verde y el Preview está listo, las misiones automáticas se lanzan solas. El evento es `deployment_status`, que solo emite la integración de Vercel en GitHub; no hay ningún endpoint público que lo acepte.

`scripts/mystery-shopper/ci-start.ts` comprueba, antes de crear nada:

- que el evento viene de este repositorio;
- que el despliegue es un Preview en estado `success`, y que su URL es un Preview de este proyecto;
- que el SHA tiene 40 caracteres hexadecimales y que todas sus comprobaciones de CI terminaron sin fallo.

Después crea un trabajo por cada misión con `auto: true`. El id sale del SHA y de la misión (`ms-ci-<sha12>-<misión>`), de modo que el mismo evento repetido no lanza otro trabajo.

## Misiones reales (catálogo)

| Misión | Producto | Automática |
|---|---|---|
| `cuenta-navegacion` | Cuenta y navegación | sí |
| `audio-proyecto-prueba` | Audio Podcast: crea, guarda y recupera un episodio de prueba, sin generar voz | sí |
| `video-podcast-costo` | Video Podcast: asistente hasta el costo por proveedor, sin autorizar | no |
| `reel-formulario` | Reels: formulario hasta el costo | no |
| `longform-formulario` | Long Form / YouTube: formulario hasta el costo | no |
| `biblioteca-recuperar` | Biblioteca: abrir, reproducir, descargar y medir la duración | sí |
| `command-center-panel` | Command Center | no |

Cada misión tiene criterios de éxito y de fracaso.

- **Nota:** un producto solo recibe nota si se comprueban **todos** sus criterios. Si no, queda **NO EVALUADO**.
- **Bloqueos:** un bloqueo crítico o un P0 anulan la nota.
- **Duración:** un archivo que se reproduce pero no dura lo pedido es **FAIL funcional**. Ejemplo: 2,16 s para una misión de 10 min.
- **Lo que no se mide:** tema, voces, idioma y sincronía labial quedan «NO MEDIDO». No se aprueban por cómo se ven.

## Dinero

- **Modo gratuito:** el navegador no pulsa nada facturable y además bloquea cualquier petición a proveedores de pago. Gasto: USD 0.
- **Modo real:** `APPROVED_REAL_BUDGET_USD = 0` en el código. Cualquier presupuesto mayor que 0 se rechaza con 409 sin crear nada. Subirlo exige un cambio revisado por Hans. El cerrojo de proveedores de la 1.0 (`PROVIDER_CALLS_ENABLED = false`) sigue igual.

## Secretos que necesita el worker

Se configuran en GitHub → Settings → Secrets. Nunca van en el código, los logs ni los informes.

| Secreto | Estado |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Ya existen; los usa el worker de video. |
| `MYSTERY_SHOPPER_QA_EMAIL`, `MYSTERY_SHOPPER_QA_PASSWORD` | **Falta.** Hace falta una cuenta QA de ATOMIVID creada por Hans. Sin ella, la evaluación queda «Bloqueada: falta la cuenta QA» y no se inventa ninguna sesión. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Solo para evaluar Previews protegidos por Vercel. |

## Pruebas

```bash
node --import tsx --test src/lib/mystery-shopper/ms2.test.ts src/lib/mystery-shopper/mystery-shopper.test.ts \
  src/lib/mystery-shopper/media.test.ts src/app/dashboard/command-center/mystery-shopper/panel.test.tsx
```

El E2E autenticado (`scripts/harness/e2e/mystery-shopper/run.sh <salida>`) corre sobre el arnés local: ATOMIVID de este checkout, cuenta QA local y USD 0. Recorre:

- el panel real del Command Center a 412×915 y 390×844;
- el doble clic, que debe dar 1 trabajo y 1 despacho;
- el worker real;
- dos workers a la vez, donde solo uno corre;
- un worker matado y reemplazado;
- el historial visto desde otra sesión;
- que no haya secretos en los informes ni salidas a proveedores.

El fixture de la 1.0 (`harness.mjs`, `walk.mjs`, `recorded/journeys.json`) queda como **prueba de infraestructura**. No es una evaluación de ATOMIVID y el panel no lo muestra como tal.

## Rollback

No hay migración ni tabla nueva. Para retirar el módulo: `git revert` del merge. Los objetos bajo `videos/mystery-shopper/v2/` son solo historial del módulo; se pueden conservar o archivar, porque nada más los lee.
