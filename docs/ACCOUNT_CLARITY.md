# Recuperación y claridad de cuenta — 19 de septiembre de 2026

Estado: implementado y verificado localmente en `codex/account-clarity`, basada en la rama principal reescrita (eabeb3bc). No incluye ni fusiona PR #10. Sin despliegue ni llamadas reales a proveedores.

## Recuperación

- Login → `/forgot-password` → Supabase Auth envía su enlace de recuperación → `/auth/callback?next=/reset-password` → `/reset-password` → login.
- PKCE: abrir el enlace en el mismo navegador que lo solicitó; se comunica antes y después del envío. El enlace es de un solo uso y su caducidad la controla Supabase. No se promete una caducidad de correo que no hemos verificado en el proyecto.
- Mensaje genérico para evitar enumeración de cuentas; Supabase mantiene sus límites de envío. Cookie de 60 segundos solo como ayuda de interfaz, nunca como protección autoritativa contra abuso.
- Origen HTTPS fijo `NEXT_PUBLIC_SITE_URL`; no se construyen enlaces desde un Origin arbitrario. Redirecciones internas validadas, sin barras invertidas ni caracteres de control.
- Únicamente un intercambio PKCE de recuperación exitoso crea prueba firmada de 15 minutos, ligada al usuario y al token de sesión. La Server Action comprueba esa prueba y `getUser` de nuevo antes de actualizar.
- Prueba HttpOnly/SameSite/Secure en producción, firma HMAC con separación de propósito usando la clave de servidor Supabase ya existente. Nunca se envía la clave al navegador. No se necesita migración de base de datos.
- Contraseña de 12–128 caracteres y confirmación coincidente, comprobadas en servidor. No se registran correo, token ni contraseña en logs.
- Tras el cambio se elimina la prueba y se solicita cierre global de sesiones. Si falla, se informa y se cierra la sesión local. Los access tokens ya emitidos pueden seguir vigentes hasta su vencimiento según Supabase; no se promete invalidación instantánea de JWT.

## Precio y cupo

- Lee exclusivamente un precio recurrente activo de Stripe TEST, con importe fijo, moneda, intervalo e impuestos explícitos. No inventa una tarifa. Precio no verificable → botón deshabilitado y servidor bloquea checkout.
- Checkout y portal rechazan claves distintas de `sk_test_` antes de llamar a Stripe. No se alteraron productos, suscripciones, usuarios, acceso beta ni webhooks.
- Cupo: consulta exacta al cargar; no es transmisión en tiempo real ni reserva. Se muestra fecha/hora UTC, límite, usados y disponibles; error de consulta nunca se convierte en cupo completo.
- UI y guard de generación comparten límite y corte de mes UTC. Cuentan solicitudes creadas este mes, en proceso o completadas. El cómputo de cuotas existente no es una reserva atómica, así se explica.

## Duración

- Formulario, revisión e historial llaman «solicitada» al objetivo.
- Historial y resultado miden duración entregada mediante metadatos del archivo final en el reproductor. Nunca sustituyen esa medición por el objetivo, por una estimación de narración o por una fila de costos.
- Muestra las dos cifras, hasta tres decimales; si difieren explica el ajuste de montaje a voz/cierre o audio/avatar. La explicación describe el comportamiento del pipeline, no pretende ser un diagnóstico forense de un video histórico.
- Mientras carga, falta el archivo o falla la reproducción, muestra duración aún no verificable. No se genera un video para obtener esta medición.

## Validación local

`npm run test:account-clarity`: 24 pruebas. Incluye SDK real de Supabase con HTTP interceptado (solicitud, PKCE, código vencido, actualización y logout), prueba falsificada/expirada/otro usuario/otra sesión, contraseñas, redirecciones, Stripe test/live y duración faltante/corta/larga.

`next typegen`, `tsc --noEmit`, ESLint de archivos modificados y `git diff --check`.

## Puesta en servicio pendiente (sin ejecutar)

1. Autorizar explícitamente cómputo de compilación/despliegue antes de publicar; no usar PR #10 ni ejecutar su workflow E2E de render.
2. Verificar en Supabase Auth que `NEXT_PUBLIC_SITE_URL` sea el dominio real y que la lista de redirect URLs permita `/auth/callback?next=/reset-password`. El correo debe conservar `{{ .ConfirmationURL }}` para PKCE. Verificar SMTP/remitente y límites existentes; no contratar servicio ni ampliar acceso.
3. Publicar rama independiente con protección de preview y sin activar workers/Stripe live.
4. Probar envío/recepción real y enlace con la cuenta del propietario. El propietario introduce y cambia su propia contraseña; no se solicita compartirla.
5. Revisar UI móvil en preview y medir videos ya existentes, sin regenerar ni consumir créditos.

No se ha confirmado entrega real del correo, configuración remota de redirects/SMTP ni prueba visual en el despliegue. No confundir pruebas locales con producción lista.

## Ticket de privacidad

#4773584 permanece abierto. Automatización por nuevo correo de GitHub Support con ese número: avisar aprobación, rechazo o solicitud de datos, ignorar acuses y no responder ni fusionar nada automáticamente.
