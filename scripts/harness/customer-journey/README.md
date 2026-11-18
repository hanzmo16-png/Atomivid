# Recorrido de cliente nuevo (local, USD 0)

Chromium real recorre la app Next de esta rama contra un **Supabase simulado** (`mock-supabase.mjs`). Stripe no tiene red, así que el Checkout falla de forma controlada. No toca producción, no usa claves reales y no cobra nada. No sustituye una prueba real con Stripe *live*.

```bash
node scripts/harness/customer-journey/mock-supabase.mjs &           # puerto 54329
# ventas abiertas (clave de PRUEBA simulada + Price IDs):
env NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54329 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-sim \
    SUPABASE_SERVICE_ROLE_KEY=service-sim NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3111 \
    STRIPE_SECRET_KEY=sk_test_simulado_sin_red STRIPE_PRICE_ID_STARTER=price_starter_sim \
    STRIPE_PRICE_ID_PRO=price_pro_sim STRIPE_PRICE_ID_BUSINESS=price_business_sim \
    npx next dev --webpack -p 3111 -H 127.0.0.1 &
APP=http://127.0.0.1:3111 MODE=open OUT=/tmp/journey node scripts/harness/customer-journey/journey.mjs
# ventas cerradas (como producción hoy): mismo servidor sin las variables STRIPE_*, MODE=closed
```

Cubre las vistas 390×844 y 412×915:
- portada;
- registro, incluida la reproducción del 429 `over_email_send_rate_limit` del 2026-10-09;
- doble toque en «Crear cuenta»;
- `redirect_to` del correo;
- «Revisa tu correo», login y panel;
- bienvenida que se puede omitir;
- aviso de suscripción;
- facturación (tres planes; abierta o cerrada);
- «Elegir Starter» con su estado de espera;
- error de Stripe sin red.

En cada vista revisa también que no haya desbordamiento horizontal y pasa axe. El contraste de los tokens globales se informa aparte como P1 conocido, sin ocultarlo.

Control negativo: con el código de producción (`4751170a`), el mismo recorrido da 6 FAIL. El doble toque provoca 2 altas, y cada una gasta un correo de la cuota de Supabase. Además, ningún botón muestra el estado de envío.
