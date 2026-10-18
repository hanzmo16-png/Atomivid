# Podcast: el scheduler no reenvía un inicio incierto

Fecha: 2026-10-18. Base productiva: `546a79250f68bcc32bb82cfcb11b381f9306c9e2`.

## Causa demostrada

`runSchedulerTick` reclama `scheduled → queued` y envía el trabajo a GitHub. Si
`dispatch` devolvía false por una respuesta perdida, volvía a escribir `scheduled`.
La siguiente activación reclamaba y despachaba otra vez aunque GitHub pudiera haber
aceptado la primera llamada. El token protegía la escritura tardía contra otro token,
pero no evitaba el reenvío automático del mismo trabajo todavía en cola.

Ocho pruebas nuevas ejecutan el scheduler y cliente Supabase reales con HTTP
interceptado. La base falla en 5/8 casos: una respuesta false provoca dos despachos
en dos ticks; un rechazo de promesa aborta el tick; el resultado no distingue falta
de confirmación. Tres casos de respuesta tardía sobre otra ejecución ya estaban
protegidos. No se observó ni se provocó un doble cobro real.

## Cambio mínimo

- Conservar la reserva `queued`, su token, heartbeat e intento ante false o excepción.
- No escribir `scheduled`, no incrementar retry_count y no reenviar automáticamente.
- Contar `unconfirmed` por separado de `dispatched`.
- Mantener el campo de respuesta `requeued` en cero por compatibilidad.
- Un fallo de confirmación no aborta las demás solicitudes independientes del tick.
- Conservar los bloqueos de presupuesto y sus avisos existentes.

## Verificación

- ROJO contra base: 3 aprobadas, 5 fallidas de 8 nuevas pruebas.
- VERDE: 8/8 nuevas; suites video + pilot + run-budget: 32/32, sin saltos.
- Dos ticks consecutivos y dos simultáneos; confirmación positiva; false; excepción;
  respuesta tardía cuando la fila ya está running/ready o tiene otro token; dos episodios.
- Solo se permite GET al ledger en el arnés; los despachos son funciones locales.
- `next typegen`, `tsc --noEmit`, ESLint completo y `git diff --check`: correctos.
- Pruebas incorporadas en pilot.test.ts, ya incluido en CI, sin cambiar package.json.
- Sin archivos compartidos con PR131/136/137/138/139/144.

## Riesgo residual y estado

Una configuración ausente o un rechazo definitivo también conserva la reserva por
precaución: el contrato booleano de dispatch no distingue esas causas de una respuesta
perdida. La recuperación manual sigue las reglas existentes de trabajo detenido
(12 minutos); el PR144 protege contra heartbeat renovado. La ausencia de heartbeat
no demuestra que no exista un worker vivo. No hay garantía exactamente-una-vez.
No se añade reconciliación automática con GitHub ni se cambia cron o workflow alguno.

La prueba modela DB/HTTP; no constituye concurrencia real en Postgres, cobros reales
ni aceptación desde cuenta autenticada. CI remoto pendiente de comprobar en el SHA
publicado. Borrador, sin merge, despliegue manual, migración, proveedor pagado,
secretos, flags o modificaciones de registros financieros/productivos.
