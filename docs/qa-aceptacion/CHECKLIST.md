# Aceptación de usuario desde la interfaz — checklist GO/NO-GO del piloto

Tarea T-20261024 QA-INTERFAZ-ACEPTACION-ATOMIVID (Claude). Gasto: **USD 0**.

- **Base auditada:** `claude/atomivid-mvp-setup-0079jv` @ `762714e`, que es lo que está en producción.
- **Rama:** `claude/qa-aceptacion-ux`. Solo contiene pruebas y documentación; no toca código de producto ni las ramas de Grok (#200, #201).

## Qué se probó y dónde

| Banco | Qué | Resultado |
|---|---|---|
| **Producción pública, solo lectura** (workflow `qa-aceptacion-publica`, run [40106805085](https://github.com/hanzmo16-png/Atomivid/actions/runs/40106805085)) | `/`, `/login`, `/register` y 4 rutas privadas sin sesión, en Samsung 390×844 y escritorio 1440×900 | **17/17 PASS** |
| **Local simulado, banco base** (`scripts/harness/e2e/qa-aceptacion/acceptance.cjs`) | Reel, Long Form y Podcast, en Samsung y escritorio | **44 PASS / 3 FAIL / 7 NO PROBADO**. 1 FAIL es un defecto real (P1-1); los otros 2 eran un error de la prueba, ya corregido: Long Form da 10/10 |
| **Local simulado, banco de podcast** (`scripts/harness/e2e/podcast/start.sh` + `QA_FLOWS=podcast`) | Crear → narrar con el mock de ElevenLabs → descargar, en Samsung y escritorio | **12/12 PASS** |

**Detalles de la auditoría pública:**
- En los dos dispositivos, todas las páginas devuelven 2xx sin scroll horizontal, y las rutas privadas redirigen a `/login`.
- Las peticiones que no son GET se **bloquean en el navegador**: la auditoría no escribe nada en producción.

**Garantías comprobadas en todos los bancos locales:**
- 0 peticiones a proveedores pagos: toda salida a internet se bloquea y se registra (`next-intercept.cjs`).
- Los renders van solo al worker local de prueba.
- La interfaz nunca muestra «listo» antes de que el estado real lo sea.

## GO/NO-GO por flujo

| Flujo | Samsung | Escritorio | Bloqueo exacto |
|---|---|---|---|
| **Reel** | **NO-GO con Recraft visible** · GO con «Material de archivo» | GO (simulado: crear → guion → revisión → render → resultado → descarga del MP4 H.264 + AAC, idéntico al almacenado) | P1-1: con «Imágenes IA con Recraft» (opción por defecto para cuentas habilitadas), el ancho de diseño pasa de 390 a **732 px** y el formulario queda cortado a la derecha (capturas `samsung-reel-recraft-pantalla.png` y `samsung-reel-archivo-pantalla.png`) |
| **Podcast estándar** | GO (simulado) | GO (simulado) | Proveedor real no probado. Si las voces no cargan, la creación se bloquea con un aviso: falla cerrada, comprobado |
| **YouTube Long Form** | NO-GO | NO-GO | La interfaz crea el trabajo y lo muestra «En cola», sin falso éxito. La confirmación de presupuesto → render → descarga **no se probó** en esta batería (necesita guion documental: ensayo existente `scripts/harness/e2e/longform-rehearsal`). Producción sigue bloqueada por #199/#201 sin fusionar y por el trigger A/B |
| **Resultado y descarga** | GO | GO | El enlace firmado se renueva al recargar. La reproducción H.264 no se comprobó en el navegador local (no trae el códec): el archivo se validó con ffprobe y su sha256 |

## Defectos (documentados, sin invadir ramas ajenas)

### P1-1 (Reel, móvil): el formulario se ensancha con Recraft

Detalle completo, capturas en tres teléfonos, prueba que falla y parche propuesto: [`RECRAFT-MOVIL-P1.md`](RECRAFT-MOVIL-P1.md).

**Causa:** el `<select name="recraft_style_missing">` y su `<label>` en `src/app/dashboard/new/ReelImageSourcePicker.tsx` tienen un ancho intrínseco de ~430–730 px, por el texto largo de las opciones. Con ellos ocultos, el ancho vuelve a 390 px.

**Corrección sugerida** (carril Recraft / Grok):
- en el `<select>` y su contenedor: `className="block w-full min-w-0 max-w-full"`, y la etiqueta en bloque;
- textos de opción más cortos.

**Prueba de regresión:** `acceptance.cjs`, comprobación «Reel con Recraft visible: el ancho de diseño sigue siendo el del dispositivo».

**Advertencia:** está verificado en la emulación móvil de Chromium. En un Samsung real el efecto esperado es que la página se aleje o quede cortada; falta confirmarlo en un dispositivo.

### P2-1 (Reel): Recraft por defecto sin estilo falla solo al enviar

Si Recraft viene preseleccionado y no hay `style_id` ni referencias, el formulario se rellena completo y solo al enviar aparece el error. No crea nada ni cobra nada, así que es correcto en dinero, pero resulta confuso para quien quiere un Reel normal.

**Sugerencia:** aviso en línea, o desactivar «Crear solicitud» hasta que haya un estilo.

### P2-2 (seguridad): faltan cabeceras en producción

`/login` envía HSTS, pero no envía:
- `Content-Security-Policy`;
- `X-Frame-Options` o `frame-ancestors`;
- `X-Content-Type-Options`;
- `Referrer-Policy`.

Sin protección anti-iframe, la página de login es susceptible de clickjacking.

### Nota de transparencia

La primera ejecución pública (run 40106395573) no bloqueaba aún las peticiones no-GET. Al visitar las páginas, el navegador envió la telemetría de la propia página: un evento de Sentry y la medición de embudo `POST /api/m`.

No se crearon trabajos ni cuentas, ni datos de usuario. Desde el run 40106805085 esas peticiones se bloquean.

## NO PROBADO (nunca cuenta como PASS)

- Producción con sesión: no hay credenciales autorizadas.
- Proveedores reales (ElevenLabs, HeyGen, Recraft, OpenAI y Anthropic): todo fue simulado.
- Long Form de punta a punta: confirmación de presupuesto → render → descarga.
- Reproducción H.264 dentro del navegador: el Chromium local no la soporta.
- Samsung físico: solo emulación de 390×844 a 3x.

## CI (USD 0)

El workflow `.github/workflows/qa-aceptacion-ux.yml` monta el arnés en el runner y ejecuta tres pasos:
1. la batería del banco base;
2. la reproducción de P1-1, que falla mientras el defecto exista y no bloquea el job;
3. el banco de podcast.

Además comprueba que no hubo ninguna salida hacia proveedores reales. En la batería, P1-1 figura como `XFAIL` y pasará a `XPASS` cuando se corrija.

## Cómo reproducir (USD 0, todo en 127.0.0.1)

```
scripts/harness/e2e/infra/setup.sh && scripts/harness/e2e/infra/start.sh
E2E_SCRIPT=qa-aceptacion/acceptance.cjs scripts/harness/e2e/infra/run-e2e.sh qa      # Reel, Long Form, Podcast (sin voces)
# Podcast completo: parar el Next del banco base y luego:
scripts/harness/e2e/podcast/start.sh
E2E_BASE=http://127.0.0.1:3300 QA_FLOWS=podcast E2E_SCRIPT=qa-aceptacion/acceptance.cjs scripts/harness/e2e/infra/run-e2e.sh qa-podcast
```

Las capturas están en `docs/qa-aceptacion/capturas/` y los resúmenes por banco en `resumen-*.json`.

## Receta para Hans desde el teléfono (cuando se autorice el despliegue)

1. Abre https://atomicvid.app en el Samsung e inicia sesión.
2. Toca **Nuevo video** → **Reel / Short**.
3. En «Imágenes del Reel», elige **Material de archivo** (hasta que se corrija P1-1).
4. Escribe el tema, elige el estilo y la duración, y toca **Crear solicitud**.
5. Toca **Generar guion**, revísalo y toca **Generar video final**.
6. Espera en el historial hasta que diga «listo». No hace falta tener la página abierta.
7. Abre el video y toca **Descargar video**.

Para el podcast:
1. **Podcast** → título y guion → **Crear episodio** (no genera ni cobra).
2. Revisa la estimación → **Generar narración** → **Descargar episodio**.

Long Form: no usar hasta cerrar #199/#201 y tener la autorización de gasto.
