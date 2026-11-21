# PROPUESTA, NO APLICADA — reserva atómica del cupo mensual comercial
Fecha: 2026-10-18/19. Alcance: cuota comercial por cuenta, independiente de costos de proveedores y de PR #148/#149.

**Estado: DISEÑO / NO_GO COMERCIAL hasta implementación, pruebas reales y aprobación del propietario.**
Este archivo NO es una migración, no cambia runtime, no configura Stripe ni autoriza gasto, render, fusión, despliegue o edición de datos de producción.

## Defecto confirmado en base de producción `bb3e4549eab8401c1ce5c3201e5a826281321994`
- `src/lib/billing/quota.ts::assertCanGenerate()` cuenta por consulta `video_requests` con `status IN ('processing','completed')`, separa avatar de no-avatar y aplica el mes UTC según `render_started_at` (fallback `created_at`).
- `src/app/api/generate/[id]/render/route.ts` invoca esa consulta antes de `reserveJobSupply()` y de un UPDATE CAS sobre **la fila de una solicitud**.
- El CAS existente impide doble inicio de un MISMO request, pero no coordina **dos IDs distintos del mismo usuario**. Al quedar 1 cupo, dos requests simultáneas leen el mismo conteo y pueden iniciar las dos.
- `docs/quality/saas-audit-20261009.md` ya registra explícitamente que el conteo comercial y la admisión de render no son una reserva transaccional de cupo por cliente.
- Los topes globales/proveedor de `pi_reserve_job_supply()` limitan dinero/capacidad; no sustituyen cuota de suscripción por usuario.

## Invariante obligatorio
Para usuario U, grupo de cuota C (avatar / no-avatar) y mes UTC M, la suma de solicitudes con admisión efectiva y sus reservas activas/consumidas no podrá superar el límite elegible verificado en el servidor. Un reintento de la MISMA solicitud nunca consume dos unidades. Ningún fallo incierto libera automáticamente la unidad y permite un segundo cobro.

## Contrato propuesto (para auditoría, no SQL listo para desplegar)
1. Crear migración propuesta separada **solo después de autorización**, con tabla de admisión por (usuario, request, mes UTC, grupo de cuota), PK o UNIQUE natural y estados HOLD/CONSUMED/RELEASED/RECONCILIATION_REQUIRED. Las restricciones identifican unívocamente el request y su período; nunca un contador anónimo sin vínculo con una solicitud.
2. Exponer RPC de servicio `claim_retail_monthly_quota(request_id, expected_render_attempt, ...)`. Lee usuario de la sesión validada por la ruta, no del navegador; dentro de una **única transacción**, bloquea la fila de suscripción del usuario o un cerrojo transaccional estable por usuario, compara plan, cuota normal/avatar y mes UTC, cuenta ocupación con el mismo bloqueo, inserta idempotentemente el claim y hace CAS de la transición admitida del request. No existe ruta alternativa para clientes comerciales que omita esta RPC.
3. El owner_test privado puede conservar su regla actual de entitlement (solo identidad verificada en el servidor); **nunca** evita controles de fondos/proveedor ni deja sin registrar el request. No extender permisos beta a clientes retail. Long Form comparte cuota no-avatar tal como el guard actual.
4. Integrar coherentemente con `reserveJobSupply`: mantener admisión de proveedor previa donde corresponda, pero si la RPC de cuota no obtiene plaza se deben liberar **solo** sobres de proveedor demostrados no utilizados. Si una llamada del proveedor se inició, su estado incierto debe permanecer retenido para conciliación. Manejar caída entre reserva de proveedor / admisión de cuota / CAS / despacho de worker con recuperación idempotente; no liberar en automático por timeout.
5. Definir y aprobar semántica de unidad: ¿se consume por inicio o por finalización? Hoy `processing/completed` ocupan cupo, `failed` no. El diseño debe distinguir fracaso antes de cualquier cobro (liberación segura) y resultado incierto/con gasto (no asumir liberación). Registrar cambios de plan, suscripción cancelada y migración a nuevo ciclo sin resetear a destiempo.
6. Todas las lecturas incompletas o RPC ausente fallan cerradas y explican al cliente el motivo; la vista de cuota podrá ser eventual, pero el inicio pago será autoritativo.

## Casos de aceptación verificables antes de tocar producción
- Con Starter 14/15, dos solicitudes diferentes simultáneas: **una admitida, una rechazada**, ocupación 15/15; nunca 16/15.
- Con Starter 15/15: ninguna admitida; Pro 29/30 y Business 59/60 muestran comportamiento equivalente.
- Dos llamadas concurrentes con el **mismo request/attempt**: una reserva comercial y un solo despacho; tras respuesta perdida, se recupera la misma.
- Una de avatar y una de Reel no se descuentan del grupo incorrecto; dos Long Form/Reel compiten por el mismo grupo no-avatar.
- Reintento tras fallo antes de toda llamada externa: misma unidad, liberación/reuso segura según política; error incierto/sin confirmación de cargo: no admitir nuevo gasto por liberación ilusoria.
- Frontera 23:59:59 UTC → 00:00:00 UTC del mes siguiente; renovación/downgrade durante carreras; cancela suscripción mientras inicia render.
- Falla de Postgres, ausencia de RPC, timeout después del commit, duplicado 23505, cambio de intento, reserva de proveedor ya existente, compensación segura.
- Prueba de concurrencia **en PostgreSQL real, en transacciones separadas**, no solo simuladores; tests de rutas server, identidad/ownership y recuperación. Registrar conteos, llamadas y hashes del código auditado.
- E2E web de pago separado del ensayo del propietario, sin afirmar lanzamiento por un CI en verde.

## Orden y límites
1. Auditoría independiente de este diseño (principalmente semántica de RELEASED, lock por suscripción y coordinación con envelopes).
2. Autorización concreta del propietario para implementación y eventual migración: **no** inferirla de este documento.
3. Implementación en PR separado con pruebas, CI, revisión de seguridad y plan de reversión.
4. Solo entonces planificar migración/apertura comercial explícitas.
No fusionar esta propuesta. No abrir correcciones adicionales de T42/T44 (sus contadores siguen separados). No duplicar PR #148 (presupuesto por material/proveedor) ni PR #149 (guion/idempotencia por solicitud). La prueba privada del primer Reel y Long Form mantienen gates independientes de paridad y costo. 
