# Podcast: recuperación sin reemplazar una ejecución renovada

Fecha: 2026-10-18. Base: `546a79250f68bcc32bb82cfcb11b381f9306c9e2`.

## Causa y reproducción

`requestPodcastVideo` decide si un video está detenido con una lectura previa del
heartbeat. Su UPDATE solo comprobaba dueño, estado e intentos. El worker puede
renovar `video_heartbeat_at` sin cambiar estado ni intentos entre ambas operaciones.
La petición antigua sustituía el token del worker activo y despachaba otra ejecución.
No se afirma que esta carrera haya sucedido en producción.

La prueba ejecuta la función real y el cliente Supabase instalado, interceptando
todo HTTP. Justo antes de evaluar los filtros del PATCH cambia la fila: heartbeat,
token, fecha alternativa de solicitud, dueño, intento o estado final. Se comprueba
respuesta 409, fila intacta y cero despachos. También se comprueba que dos peticiones
con la misma lectura realmente obsoleta tienen un único ganador, incluidos campos
históricos nulos. No hay llamadas a proveedores ni escrituras productivas.

- ROJO contra la base: 10/20 fallos (heartbeat/token/fecha alternativa, queued y running).
- VERDE con la corrección: 20/20.
- Suites video + pilot + run-budget: 44/44, sin saltos.
- `next typegen`, `tsc --noEmit` y ESLint completo: exit 0.

## Corrección mínima

El UPDATE de recuperación también exige el mismo `video_run_token`,
`video_heartbeat_at` y `video_requested_at` que la lectura usada para determinar
inactividad. Para valores nulos usa `IS NULL`, no igualdad con NULL. Si cualquiera
cambia, no se actualiza ni despacha y el usuario debe recargar. No modifica plazos,
presupuestos, contadores financieros, worker ni reglas de gasto.

La consulta de metadata de Supabase confirmó que las cinco columnas requeridas ya
existen (token UUID, timestamps timestamptz, intentos integer NOT NULL y estado text
NOT NULL). No se necesita migración. La documentación actual de Supabase confirma
`is(column, null)` para este filtro: https://supabase.com/docs/reference/javascript/is.

## Límites y entrega

Esta prueba modela la evaluación atómica de filtros; no es una carrera ejecutada en
Postgres productivo ni una prueba desde cuenta real. La pérdida total de heartbeat
todavía puede habilitar la recuperación de un proceso vivo: el plazo de 12 minutos
no demuestra que haya muerto. No garantiza exactamente una ejecución ni un cobro.
Campos nulos mantienen la política previa de recuperación, con filtros explícitos.

El PR139 resuelve por separado la respuesta incierta del despacho. Este cambio sale
de la base productiva y no incluye PR139. Ambos deben integrarse y validarse juntos.
No modifica archivos de PR131/136/137. El scheduler y su reencolado ante respuesta
incierta requieren una auditoría posterior.

Estado de esta evidencia: probado localmente; CI remoto debe comprobarse en el SHA
publicado. Borrador, sin merge, despliegue manual, proveedores pagados, migraciones
ni validación autenticada. Los previews automáticos de la integración existente no
equivalen a despliegue en producción.
