# Mystery Shopper AI 1.0

Módulo del Command Center. Recorre una misión como un cliente, valida el archivo con ffprobe/ffmpeg y escribe un informe. No rediseña ATOMIVID, no toca Podcast Premium, no escribe en Supabase y no llama a proveedores.

El panel está en `/dashboard/command-center#mystery-shopper`. Lo ve quien ya puede abrir el Command Center (dueño o admin). Cualquier otra sesión recibe 404, igual que el resto de esa página.

## Modos

- **A · Gratuito.** Recorre un arnés local marcado `FIXTURE` en cada pantalla y usa archivos ya generados en la misma máquina. El gasto es USD 0. Es el único modo que puede arrancar solo.
- **B · Real.** El código comprueba autorización de Hans, misión, presupuesto máximo, estimación verificable, reserva, id único, doble cobro, reintentos (máximo 2), cancelación y costo desconocido. Si falta cualquiera, queda `BLOQUEADA`. Aunque todo cuadre, la constante `PROVIDER_CALLS_ENABLED` está en `false`: no hay llamada de red. Cambiar ese cerrojo exige un diff revisado. Un secreto de entorno no lo abre.

## Dónde corre el navegador

Playwright no corre dentro de una función serverless de Vercel. El recorrido lo hace el workflow `.github/workflows/mystery-shopper.yml`, en GitHub Actions, sin servicios de pago. El botón del panel, en Preview, evalúa el recorrido fixture ya grabado y, si no hay grabación para esa misión, responde `BLOQUEADA` con el motivo. No promete un navegador residente en Vercel.

El workflow acepta tres entradas, todas gratuitas:

- un pull request que toca este módulo;
- `workflow_dispatch` (si el modo pedido es `real`, se detiene antes del navegador);
- `repository_dispatch` del tipo `mystery-shopper-preview-ready`.

Ese dispatch es el enganche verificable. Para un Preview de Vercel el payload tiene que traer `source: "vercel"`, `preview: "READY"`, `sha`, `executionId` y `mode: "fixture"`. El mismo `executionId` no se vuelve a correr. No hay un único workflow de CI en el repo al que engancharse sin arrastrar jobs de pago, así que este módulo no escucha el resto de workflows.

## Cuenta de prueba

En este entorno no había `MYSTERY_SHOPPER_QA_EMAIL` ni `MYSTERY_SHOPPER_QA_PASSWORD`. No se inventó una cuenta ni se escribió una contraseña en `https://atomivid.vercel.app/login`. Esa URL respondió HTTP 200 y mostró el formulario de acceso. Los productos que están detrás del inicio de sesión quedan `NO_VERIFICADO` en ATOMIVID real.

Para repetir el recorrido dentro de ATOMIVID hace falta una cuenta de prueba autorizada por Hans, cargada como secreto de CI, y la URL del Preview. El worker solo escribe esa contraseña si el host es `127.0.0.1`.

## Cómo correrlo en local

```bash
npm run test:mystery-shopper
```

El test de navegador instala Playwright aparte (`npm install --no-save playwright@1.49.1` y `npx playwright install chromium`). No es dependencia del build. Genera el informe en `artifacts/mystery-shopper/informe-audio.json` y las capturas en `artifacts/mystery-shopper/evidence/`.

## Rollback

No hay migración ni fila nueva en Supabase. Para retirar el módulo:

```bash
git revert <sha-de-este-cambio>
```

Eso quita el panel, la ruta `/api/admin/mystery-shopper`, el workflow y `src/lib/mystery-shopper`. No hay datos de producción que restaurar.

El manifiesto SHA-256 de los archivos nuevos está en `docs/mystery-shopper/MANIFEST.sha256`.
