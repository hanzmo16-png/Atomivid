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

**Unitarias** (`src/lib/security-headers.test.ts`, en el workflow propio `security-headers`, que se dispara con cualquier cambio en `next.config.*`, `src/lib/security-headers*` o `src/proxy.ts`; no van en `test:unit` para no chocar en `package.json` con #199/#200):
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

**Funciones frente a la política** (mismo script, sección 4; T-20261024 QA final), en Samsung 390×844 y escritorio 1440×900, sobre el servidor Next real y sobre una página servida con las cabeceras calculadas para la forma de producción (Supabase `https://…supabase.co`, DSN de Sentry):
- **deben dar 0 violaciones**, ni aplicadas ni de informe: login con Supabase Auth, Realtime (WebSocket), imagen y video firmados de Storage, subida firmada (PUT), vistas previas `blob:`, envío a Sentry (simulado), API propia y Stripe simulado (formulario directo y formulario → 303 → Checkout / Portal);
- **controles negativos**, que deben producir la violación esperada para probar que el detector funciona: conexión a un origen no permitido y formulario a un origen no permitido (directo y por 303) dan un aviso de informe sin bloquear; `<object>` y `<base>` ajeno se bloquean.

Ningún host externo sale del runner: los stubs locales responden antes de la red y el navegador no resuelve ningún DNS externo. Resultado en `security-out/csp-scenarios.json`.

**Con sesión y flujos completos:** la batería de aceptación de #202 registra las violaciones de CSP (aplicada = FAIL, informe = INFO) y se ejecuta con estas cabeceras en la rama de verificación `claude/verify-202-203` (#202 + #203).

## Siguiente paso (no incluido aquí)

1. Desplegar y observar los avisos del modo informe en producción durante unos días: consola, o un `report-to` propio si se decide.
2. Pasar a aplicada, directiva por directiva, la parte de la política sin avisos (`object-src`, `base-uri`, `form-action`, `connect-src`…).
3. Evaluar los nonces cuando se acepte el coste del renderizado dinámico.
