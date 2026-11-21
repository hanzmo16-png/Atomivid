# Lanzamiento a clientes: registro + Stripe (lo que falta y cómo verificarlo)

Rama `claude/customer-launch-readiness` (PR #294, borrador). Todo lo de aquí se probó **sin dinero real**: Supabase y Stripe simulados en local, y webhooks firmados con el SDK real de Stripe. **Nada de esto demuestra que Stripe Live o el correo de producción funcionen.** Eso solo lo prueban los pasos marcados como «Hans».

## Qué está comprobado (USD 0)
| Recorrido | Evidencia |
|---|---|
| Registro → «Revisa tu correo» → login → panel (390×844 y 412×915) | `scripts/harness/customer-journey` modo `open`/`closed`/`paid` |
| Cuota de correo agotada (429 `over_email_send_rate_limit`) → mensaje claro | mismo arnés y `customer-journey.test.tsx` |
| Doble toque en registro, login, pago y recuperación de contraseña → un solo envío | arnés + `customer-journey.test.tsx` |
| Elegir Pro → Checkout de prueba → webhook `checkout.session.completed` firmado → «Plan actual Atomicvid Pro» | arnés modo `paid` |
| Con plan activo no se ofrece otro plan; el servidor rechaza un segundo Checkout | arnés `paid` + `stripe-lifecycle.test.ts` |
| Impago (`past_due`) → sin acceso, «Actualizar método de pago», sin segundo cobro | arnés `paid` + `stripe-lifecycle.test.ts` |
| Renovación, cancelación al final del periodo, baja, evento viejo fuera de orden, duplicados | `stripe-lifecycle.test.ts` |
| Firma alterada, caducada (> 5 min) o con otro secreto → 400, sin escribir nada | `stripe-lifecycle.test.ts`, `webhook.test.ts` |
| Crear un Reel y elegir el proveedor de imágenes (archivo / Recraft / FLUX) → solicitud guardada sin cobro | arnés `paid` (FLUX/Recraft encendidos **solo** en ese entorno local) |

## 1. Correo de confirmación (SMTP) — Hans, en Supabase
No cambia ninguna credencial existente; es configuración nueva.
1. Elegir un proveedor SMTP (Resend, Postmark o SendGrid) y verificar el dominio `atomicvid.app` con SPF y DKIM (y DMARC recomendado).
2. Supabase → Authentication → **SMTP Settings** → *Enable custom SMTP*:
   - Sender email `no-reply@atomicvid.app`, sender name `Atomicvid`;
   - host, puerto 587 y usuario y contraseña **del proveedor**. Se escriben solo ahí, nunca en el chat ni en el repositorio.
3. Authentication → **Rate Limits**: subir «emails per hour» (por ejemplo a 100). Con el remitente integrado de Supabase el límite es tan bajo que provocó el fallo del 9 de octubre.
4. Authentication → **URL Configuration**:
   - Site URL `https://atomicvid.app`;
   - Redirect URLs `https://atomicvid.app/auth/callback`.
5. Vercel (Production): `NEXT_PUBLIC_SITE_URL=https://atomicvid.app` y redeploy.
6. **Prueba (Hans, celular, USD 0):**
   - crear una cuenta con un correo real: el correo llega, el enlace abre `atomicvid.app` y se puede iniciar sesión;
   - «¿Olvidaste tu contraseña?»: llega el correo, se cambia la contraseña y se entra con la nueva.

## 2. Stripe Live — checklist (Hans)
1. Stripe en modo **live**: crear 3 productos con precio mensual recurrente en USD: Starter 19, Pro 49, Business 129.
2. Copiar los 3 `price_…` de live. Los de test no sirven: el código rechaza vender con clave de prueba en producción.
3. Developers → Webhooks (live) → endpoint `https://atomicvid.app/api/stripe/webhook` con estos eventos:
   - `checkout.session.completed`;
   - `customer.subscription.created`, `customer.subscription.updated` y `customer.subscription.deleted`.
   Copiar su `whsec_…`.
4. Settings → Billing → **Customer portal**: activarlo, con «actualizar método de pago», «cancelar» y «cambiar de plan» entre los 3 precios.
5. Settings → Billing → **Subscriptions and emails**: activar *Smart Retries* y los correos de pago fallido. El código ya muestra «Actualizar método de pago» mientras la suscripción está en `past_due`.
6. Vercel → Production → variables:
   - `STRIPE_SECRET_KEY`: una clave `rk_live_…` restringida (Checkout, Subscriptions, Customer portal) o `sk_live_…`;
   - `STRIPE_PRICE_ID_STARTER`, `STRIPE_PRICE_ID_PRO` y `STRIPE_PRICE_ID_BUSINESS`;
   - `STRIPE_WEBHOOK_SECRET`, con el valor de live.

   Después, **redeploy**.
7. Comprobación sin cobro (yo, después del redeploy): smoke de solo lectura. `/dashboard/billing` debe mostrar «Elegir …» y **no** el aviso «Entorno de prueba de Stripe».

## 3. Transacción real controlada (solo con autorización expresa de Hans)
1. Hans, desde el celular: crear una cuenta nueva con un correo propio y confirmarla.
2. Facturación → **Elegir Starter** (USD 19) → pagar con su tarjeta real.
3. Comprobar en la app que aparece «Plan actual Atomicvid Starter · Activa · Se renueva el …».
4. Comprobar en Stripe → Webhooks → el endpoint: la entrega `checkout.session.completed` debe estar en **200**.
5. «Nuevo video» → crear un Reel de 15 s. El primer Reel real tiene un coste de proveedores de unos USD 0,10–0,50, que también requiere autorización.
6. «Administrar suscripción» → cancelar. En la app debe aparecer «Se cancela el …» y el acceso debe seguir hasta esa fecha.
7. Reembolsar en Stripe → Payments → *Refund*. El neto queda en USD 0, salvo la comisión de Stripe, que no se devuelve.
8. Mandarme la hora. Verifico la fila de la suscripción con una consulta de solo lectura.

## Rollback
- Código: `git revert -m 1 <merge de #294>`. No hay migraciones ni cambios de esquema.
- Ventas: quitar `STRIPE_PRICE_ID_*` en Vercel y hacer redeploy. Los botones pasan a «Pagos aún no habilitados» y no se abre ningún Checkout.
- SMTP: desactivar *custom SMTP* en Supabase. Vuelve el remitente integrado, con su límite bajo.
