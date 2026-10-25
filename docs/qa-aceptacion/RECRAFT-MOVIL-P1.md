# P1-1 — En el móvil, el formulario de Reel se ensancha cuando se elige Recraft

**Estado:** abierto en producción. Corrección propuesta en un PR independiente, [#219](https://github.com/hanzmo16-png/Atomivid/pull/219) (solo CSS, el parche de abajo). Verificada en emulación en el PR de verificación [#220](https://github.com/hanzmo16-png/Atomivid/pull/220) (#202 + #219): reproducción 3/3 PASS y `XPASS [P1-1]`. Falta confirmarla en un Samsung físico.

**Dueño de la corrección:** carril Recraft (Grok). Este documento **no** modifica `src/app/dashboard/new/ReelImageSourcePicker.tsx`; solo aporta la reproducción, la evidencia y una propuesta.

## Síntoma

En un teléfono, al elegir «Imágenes IA con Recraft» (la opción por defecto para las cuentas con Recraft habilitado), el ancho de diseño de la página pasa del ancho del dispositivo a **732 px**. Pasa en el formulario de Reel y en Configurar de Long Form, que usan el mismo componente.

Consecuencias:
- el formulario queda cortado a la derecha;
- en la emulación, el toque en «Crear solicitud» lo intercepta el `<input type=file>` de referencias.

Con «Material de archivo», el ancho vuelve a ser el del dispositivo.

| Dispositivo (emulado) | Con Recraft | Con «Material de archivo» |
|---|---|---|
| Samsung 390×844 | **732 px** | 390 px |
| Pixel 7 412×915 | **732 px** | 412 px |
| iPhone SE 375×667 | **732 px** | 375 px |

**Capturas a tamaño de pantalla** (`capturas/`):
- `samsung-reel-recraft-pantalla.png`: el defecto (texto y campos cortados);
- `samsung-reel-archivo-pantalla.png`: el mismo formulario sin Recraft;
- `pixel-7-412-recraft.png` e `iphone-se-375-recraft.png`;
- `samsung-reel-recraft-propuesta-css-inyectado.png`: la propuesta aplicada en el navegador, con ancho 390 y botón pulsable.

En escritorio (1440×900) no hay defecto.

## Causa (medida, no supuesta)

Se ocultaron los elementos uno a uno y se midió el ancho de diseño tras cada uno. Detalle en `recraft-mobile-repro-antes.json`.

1. `<select name="recraft_style_missing">`: un `<select>` toma el ancho de su opción más larga («Continuar con las mismas referencias (hasta USD 0,005 más por imagen; el plan ya lo cubre)»). Ocultarlo baja el ancho de 732 a 432 px.
2. `<input name="recraft_style_refs" type="file">`: tiene un ancho intrínseco de ~340 px y padding alrededor; deja el ancho en 432 px.
3. `<fieldset>` tiene por defecto `min-inline-size: min-content`, así que el fieldset crece hasta el contenido más ancho en lugar de encogerse.

## Propuesta (validada inyectando el CSS equivalente en el navegador)

Parche listo: [`recraft-movil-propuesta.patch`](recraft-movil-propuesta.patch). Son 4 cambios de clase, sin cambios de lógica ni de textos:
- `<fieldset>`: `min-w-0`;
- los dos `<select>`: `block w-full min-w-0 max-w-full`;
- el `<input type=file>`: `w-full min-w-0 max-w-full`.

Variantes medidas en Samsung 390:

| Variante | Ancho de diseño | «Crear solicitud» pulsable |
|---|---|---|
| Sin corregir | 732 | no |
| Solo `fieldset min-w-0` | 732 | no |
| Solo `select w-full min-w-0` | 432 | sí |
| **Fieldset + selects + input file (propuesta)** | **390** | **sí** |

Complemento opcional: acortar el texto de la opción `same_references` y llevar el detalle a un texto de ayuda.

## Prueba que falla antes de la corrección

```
scripts/harness/e2e/infra/setup.sh && scripts/harness/e2e/infra/start.sh
E2E_SCRIPT=qa-aceptacion/recraft-mobile-repro.cjs scripts/harness/e2e/infra/run-e2e.sh recraft-repro
```

- Hoy: `RESULTADO 0/3 PASS — defecto P1-1 presente`, exit 1.
- Tras el parche, el resultado esperado es 3/3 PASS y exit 0.

En CI se ejecuta en el workflow `qa-aceptacion-ux`, job «Reproducción P1-1». Ese job está marcado `continue-on-error` para que el PR muestre el defecto sin bloquearse por él. La batería de aceptación lo registra como `XFAIL [P1-1]` y lo pasará a `XPASS` cuando se corrija.

## Límite de la evidencia

Todo se midió en la emulación móvil de Chromium (viewport + táctil + escala). Falta confirmarlo en un Samsung físico. Basta con abrir Nuevo video → Reel en el teléfono con Recraft habilitado.
