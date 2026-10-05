# Atomivid — control preventivo de suministro y lanzamiento

Actualización: 5 de octubre de 2026. El objetivo es terminar las funciones existentes con calidad y previsión de capacidad. Este cambio no abre promociones, compra créditos ni modifica membresías.

## Comportamiento implementado

| Situación | Control | Resultado |
|---|---|---|
| Empieza un reel, avatar o documental | Reserva atómica de unidades por proveedor y dinero para todo el trabajo | No acepta producción sin recursos y presupuesto comprobados |
| Una corrección de voz, imagen, guion, avatar, música o VFX va a llamar a un proveedor pagado | Puerta de suministro y registro de operación antes del HTTP | Cupo, saldo y topes se comprueban en la misma transacción |
| Llegan solicitudes simultáneas | Bloqueo del presupuesto global, reservas por trabajo, límite por proveedor y límite de trabajadores | Dos solicitudes no pueden usar el mismo saldo; el exceso espera |
| Queda 30 % o menos de saldo libre, o cobertura de 72 horas o menos | Aviso amarillo persistente | Reponer antes de agotar el suministro |
| Queda 15 % o menos, cobertura de 24 horas o menos, o proveedor caído | Aviso urgente y pausa de nuevas admisiones | Los trabajos ya financiados pueden seguir dentro de su reserva si el saldo real aún los cubre |
| Falta saldo, cupo o una prueba de disponibilidad vigente | Espera durable y mensaje claro | Se conservan solicitud, intento y archivos; no se reemplazan imágenes de calidad por material ajeno al tema |
| Hay un cobro/submisión incierto | Se conserva el consumo reservado y se exige conciliación | No se vuelve a gastar por un reinicio, tiempo agotado o fallo posterior |
| Falla la entrega del aviso | Bandeja persistente con ID de evento estable | Se vuelve a intentar; no se declara entregado sin respuesta satisfactoria |
| Alguien solicita contenido gratuito | Bolsa gratuita cerrada por defecto | Costo promocional cero hasta autorizar un piloto con presupuesto separado |

La reserva incluye una corrección de ritmo en el reel, revisión visual y generación de imágenes cuando están habilitadas, los topes de avatar/música y el plan confirmado del documental. Los dos proveedores generativos de Long Form reciben reservas conservadoras que pueden superar el consumo final: se privilegia terminar trabajos financiados. Solo se libera capacidad sin usar; los consumos enviados siguen en el registro.

La cobertura usa el mayor entre previsión, pico diario observado y demanda pendiente. Las pruebas de saldo caducan a los cinco minutos; una estimación, una API sin dato de saldo, una fecha futura o un número no finito no autorizan gasto.

## Monitoreo y avisos

- Cron cada cinco minutos: `/api/cron/supply`, protegido con `CRON_SECRET` de al menos 32 caracteres. El cron automático de Vercel se ejecuta en Production; el código no ha sido promovido allí.
- Command Center: panel solo para propietario/administrador con saldo libre, cobertura, avisos pendientes y trabajos en espera. Desconocido se muestra como «Sin verificar», no como cero o disponibilidad.
- Destino de alarma: `SUPPLY_ALERT_WEBHOOK_URL` HTTPS elegido por el propietario y token opcional. Sin destino, los avisos se almacenan pero no llegan a un correo/teléfono. La recepción real debe probarse antes del lanzamiento. El receptor debe deduplicar por `Idempotency-Key`.
- Reanudación de trabajos: `SUPPLY_RESUME_ENABLED=false` hasta comprobar despliegue, cuentas y alarma. Solo reanuda trabajos ya iniciados, con el mismo intento. Excluye permisos privados de una sola prueba y consumos inciertos.

## Proveedores y evidencia

| Proveedor | Lectura implementada | Condición para habilitar |
|---|---|---|
| ElevenLabs | GET `/v1/user/subscription`; caracteres incluidos restantes | Identificar cuenta/modelo, tarifa real y concurrencia. No se añade una extensión PAYG sin verificar su cartera |
| Runway | GET `/v1/organization`; `creditBalance` | Cuenta API y tarifa por crédito comprobadas; no confundir saldo de suscripción web |
| HeyGen | GET `/v3/users/me`; cartera prepagada USD o créditos | Moneda y cartera de API verificadas. Las bolsas de suscripción y un límite de facturación no se convierten en dinero disponible |
| OpenAI / Anthropic | Puerta de gasto por llamada y reserva por trabajo | Falta certificar una fuente de saldo/fondos utilizable. No se convierte un cálculo del registro en saldo bancario o cartera real |
| Luma / Veo / BFL / LTX / Beatoven u otros VFX pagados | Puerta compartida de suministro para operaciones que usan el registro | Falta verificar sus cuentas, lectura de saldo, límites y costos. Siguen cerrados si no hay evidencia vigente |
| Vercel / GitHub Actions / Supabase / archivo gratuito | Límite de trabajadores y cola, además de controles existentes | Verificar uso, almacenamiento, transferencia, minutos, cuotas y alarmas nativas. Este cambio no certifica esos límites ni consulta el saldo del banco |

Fuentes técnicas oficiales verificadas: [ElevenLabs subscription](https://elevenlabs.io/docs/api-reference/user/subscription), [Runway API](https://docs.dev.runwayml.com/api/), [HeyGen current user](https://developers.heygen.com/user-profile). Los adaptadores consultan mediante GET; no hay endpoint de compra o generación en el monitor.

## Activación antes de vender

1. Completar una matriz de cuentas reales: proveedor, uso, modelo, moneda/unidad, saldo leído, fecha, tarifa, límite simultáneo, límite diario, renovación y prueba de facturación. No asumir que una suscripción de la web paga el uso de API.
2. Definir el dinero realmente asignado a generación: techo diario y mensual global, reparto por proveedor y límite de trabajadores. `pi_supply_policies` se instaló con todas las políticas apagadas y topes en cero. La columna `evidence` registra la comprobación; no lleva claves.
3. Planificar al menos el escenario de 50 clientes diarios usando la mezcla real de reels/avatares/documentales, sus longitudes y correcciones. `daily_forecast` debe reflejar ese piso y el margen de reposición. No se certifican 50 videos/día con una prueba simulada.
4. Separar el presupuesto de generación de la publicidad (MXN 2,100–4,200 para el experimento inicial), cargos fijos de infraestructura, impuestos y reserva bancaria. Los topes SQL cubren llamadas pagadas de proveedores, no todos los cargos de esa tarjeta.
5. Configurar `CRON_SECRET` y el destino de avisos, leer saldos reales con las credenciales del mismo servicio que generará y comprobar que la alarma llega. Revisar cualquier recarga nativa ya existente y sus límites; este cambio no la enciende ni la compra.
6. Desplegar página y worker juntos desde el mismo código y con precios/flags coherentes. Verificar el ref efectivo de GitHub (`GH_WORKER_REF`): una página corregida con un worker viejo no está protegida de extremo a extremo.
7. Ejecutar aceptación limitada y financiada: guion, reserva, progreso, suministro bajo, alarma, cola, reposición, mismo intento, reproducción y descarga; incluir las modalidades que se ofrecerán. Las llamadas reales requieren un cupo específico ya financiado.
8. Validar registro, cobro/webhook, límites de membresía y cancelación en el modo Stripe correcto. Mantener cerrada la campaña de ventas hasta completar estas comprobaciones y las aceptaciones pendientes de `SAAS_LAUNCH_CHECKLIST.md`.

No se exige comprar un plan grande anticipadamente. Se arranca con el cupo comprobado, se limita la admisión a ese cupo y se aumenta con fondos asignados. Vender membresías y garantizar su capacidad de uso requiere comprobar las obligaciones del plan, no solo contar anuncios o registros.

## Conciliación y fallos

- Un consumo `SUBMITTED` sin respuesta o `RECONCILIATION_REQUIRED` no se reenvía automáticamente. Consultar al proveedor y sus cargos/jobs antes de reconocer devolución o consumo final.
- Una reserva no caduca por el paso del tiempo. Un trabajador huérfano requiere comprobación de su estado antes de liberar cupo. Liberar solo el resto de una reserva no devuelve consumo ya enviado.
- Los avisos pendientes deben revisarse si el canal de entrega falla. La plataforma necesita una alarma nativa/operativa independiente para detectar un cron que dejó de ejecutarse; no se ha configurado esa alarma externa.
- Ninguna prueba local garantiza cero caídas del proveedor. La aceptación debe demostrar preservación de avances, límites de dinero y recuperación sin duplicar cargos.

## Evidencia de este cambio

- 1,668 pruebas automáticas aprobadas; tipos, lint y compilación de producción aprobados, sin generación pagada.
- Simulaciones concurrentes de 50 solicitudes; en la puerta de llamadas se respeta un cupo de tres y las rechazadas permanecen RESERVED.
- Pruebas SQL con BEGIN/ROLLBACK: reserva de trabajo multiproveedor sin fugas parciales, presupuesto global con pendientes, mismo intento sin doble reserva, consumo sin doble resta, devolución solo de capacidad sin usar, saldo recién agotado, promoción cerrada y funciones privadas.
- Prueba SQL de 50 reclamos de trabajador: tres admitidos y 47 en espera, sin aumentar intentos.
- Fixtures SQL en `supabase/migrations/verify/provider_supply_*.sql`; no hacen llamadas a proveedores. No equivalen a 50 clientes atendidos en vivo.
- Cuatro migraciones instaladas sin activar las políticas. El código nuevo aún requiere revisión y despliegue coordinado; no se declara listo el lanzamiento.
