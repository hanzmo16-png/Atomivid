# Encabezados de seguridad de la web

**Origen:** auditoría de aceptación (PR #202). Hasta ahora, producción solo enviaba `Strict-Transport-Security`.

## Qué se envía (todas las rutas, `next.config.ts` → `src/lib/security-headers.ts`)

| Encabezado | Valor | Efecto |
|---|---|---|
| `Content-Security-Policy` (**aplicada**) | `frame-ancestors 'none'; object-src 'none'; base-uri 'self'` | Ningún sitio puede incrustar Atomivid en un iframe (clickjacking). Bloquea plugins y la inyección de `<base>` |
| `Content-Security-Policy-Report-Only` | Política completa (scripts, estilos, imágenes, medios, conexiones a Supabase https/wss y Sentry, Stripe, `form-action`) | **No bloquea**: el navegador solo avisa en la consola. Sin `report-uri`, no se envía nada a ningún servicio |
| `X-Frame-Options` | `DENY` | Anti-iframe para navegadores antiguos |
| `X-Content-Type-Options` | `nosniff` | Sin «adivinar» tipos MIME |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | El valor por defecto de los navegadores modernos, ahora explícito: a terceros solo llega el origen |

## Por qué no se aplica la CSP completa todavía

Una CSP estricta (con nonce) obliga a renderizar en dinámico todas las páginas (guía de Next: `content-security-policy.md`). Además depende de orígenes que cambian por entorno:
- Supabase (auth, Storage, subidas firmadas desde el navegador y realtime);
- los enlaces firmados de medios;
- Sentry;
- Stripe (Checkout y portal);
- la autorización de Google (YouTube);
- la barra de Vercel en Previews.

Aplicarla sin datos reales podría romper el login, las subidas o la reproducción. La directiva aplicada se limita a lo que no puede romper nada; la completa se mide primero en modo informe.

## Verificación (USD 0)

**Unitarias** (`src/lib/security-headers.test.ts`, incluidas en `test:unit`):
- valores exactos de cada encabezado;
- la CSP aplicada no contiene directivas de carga;
- el modo informe incluye Supabase https/wss y Sentry, sin `unsafe-eval` en producción y sin endpoint de informes;
- `next.config` las aplica a todas las rutas.

**Navegador** (`scripts/qa/security-headers-check.cjs`, workflow `security-headers`):
- cabeceras en `/`, `/login`, `/register`, `/api/m` y en un 404 de `_next/static`;
- **un sitio ajeno no puede incrustar `/login`** (captura `capturas/iframe-bloqueado.png`: el iframe queda vacío);
- 0 violaciones de la CSP aplicada en Samsung 390×844 y escritorio 1440×900.

**Con sesión, en el arnés local:**
- 7 páginas (públicas, panel, nuevo video, Podcast y Long Form) con 0 violaciones aplicadas y **0 avisos en modo informe**, después de añadir el origen de Storage a `media-src` e `img-src`. El primer pase encontró los medios firmados de Storage (`http` en local).
- La **batería de aceptación completa** (PR #202) pasa con estos encabezados:
  - Reel: crear → render → resultado → descarga idéntica (22 PASS);
  - Long Form;
  - Podcast;
  - 0 salidas a proveedores.

## Siguiente paso (no incluido aquí)

1. Desplegar y observar los avisos del modo informe en producción durante unos días: consola, o un `report-to` propio si se decide.
2. Pasar a aplicada, directiva por directiva, la parte de la política sin avisos (`object-src`, `base-uri`, `form-action`, `connect-src`…).
3. Evaluar los nonces cuando se acepte el coste del renderizado dinámico.
