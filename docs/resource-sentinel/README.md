# Resource Sentinel — backend P0

Origen: `482fef654a1358e27cc647c729ee61563600d916`. Rama aislada `codex/resource-sentinel-20261126`. No modifica Premium, fuentes de Claude, secretos, migraciones o datos productivos. Desarrollo/pruebas sin proveedores: USD0. No consume ni reinicia el ledger de Mystery Shopper.

## Implementado

- Un solo monitor compartido por el cron existente y el scheduler GitHub existente: este último pasa de horario a `*/5 * * * *`. La ejecución es best effort de GitHub, no una garantía de puntualidad. Usa los mismos bindings; no se crearon secretos. El script legacy conserva sus exports para regresiones, pero su ejecución directa se niega a iniciar un segundo monitor.
- Solo GET de facturación oficiales; no recargas, webhooks, generación ni reanudación de workers desde el nuevo entrypoint. Lecturas cada>=300s por observación persistida, coalescing por cliente y backoff `Retry-After` persistido en la bandeja privada existente. Sin lease distribuido global de lectura: no se afirma exclusión multi-host del GET. Una lectura o cuota no acreditada nunca habilita una llamada pagada.
- Recraft/FLUX comparten una billetera fal.ai en el monitor y la vista. Sus saldos no se suman. API fallida/stale/manual/desconocida se distingue de saldo API fresco; copiar una observación a un alias no rejuvenece su timestamp.
- Incidentes sin acuse se deduplican por cuenta de facturación y severidad incluso al cambiar la ventana temporal; subir de severidad conserva un incidente distinto. No se mandan notificaciones externas.
- `GET /api/command-center/resource-sentinel`: administrador confirmado exclusivamente, sin caché; auth antes de construir cliente service-role. DTO sin usuarios, claves, payloads ni referencias privadas de trabajos. Integra lectura del guardia SQL, reservas existentes, historial paginado completo, slots y límites de cobertura. El semáforo operativo jamás anula un rechazo del guardia SQL.
- Consumos diario/7d/mes diferenciados entre registrados/estimados; límites por unidad, no suma USD+créditos+caracteres. La proyección 7/14d es una estimación simple y exige historia suficiente del proveedor, muestras y días activos. Cero muestras/consumo nunca significa autonomía infinita. Umbrales se validan en el modelo; no modifican límites financieros. Enlaces oficiales son manuales, sin compras automáticas.
- GPU, cuota de almacenamiento y peticiones restantes siguen UNKNOWN salvo telemetría acreditada; no se inventa disponibilidad. Los slots medidos pertenecen a video_requests, no a todos los workers de Audio/Podcast.
- Reanudación Long Form conserva el timeout derivado de duración (180s→45min) y el mismo intento; un dato inválido no cae al default330min ni despacha otro trabajo.

## Límites críticos y matriz de cuatro productos

| Producto/ruta | Resultado de esta candidata | Límite |
|---|---|---|
| Long Form | Guardas y reserva existentes preservadas; recuperación corregida y probada offline | No nueva generación real en esta tarea |
| Reels | Llamadas pagadas siguen el ledger y RPC existentes | Fal con ambos alias habilitados queda en espera hasta disponer de pooling autoritativo |
| Audio Studio | Caché/MP3 existente y fixture/demo local preservados; nuevos segmentos reales sin reserva común se bloquean antes de TTS | El RPC integral existente exige video_requests; no puede certificar proyectos Audio almacenados en JSON sin cambiar su contrato. No se inventaron filas de video ni ledger alternativo |
| Podcast audiovisual | Guardas existentes privadas intactas; el DTO explicita que su ledger no es un pool PI certificado | Reserva compartida entre sus operaciones y PI no acreditada; no se presume integración global |

El guardia fal prueba con lectura exhaustiva las políticas: ambas habilitadas→espera sin RPC pagado; actual inexistente/malformada/error/truncamiento→rechazo; peer opcional ausente en lectura completa→no configurado, y el SQL ya impide que ese alias pague. No exige aplicar la migración opcional de FLUX para seguir usando Recraft solo. No elimina la carrera de cambio administrativo de políticas: pooling atómico real requiere una modificación SQL que esta misión prohíbe.

**NO-GO para declarar protección financiera global de los cuatro productos.** Los contadores cruzados de Audio/Podcast aún no están reconciliados con PI; para esos proveedores se ve el saldo API acreditado, pero saldo libre/autonomía quedan desconocidos. El consumo PI parcial lleva su etiqueta y no se utiliza para prometer autonomía global. Saldo API cero/caída acreditada sigue ROJO, incluso con contabilidad incompleta. La UI y el rollout no deben ocultar estos límites.

El commit de Audio es deliberadamente independiente: evita un bypass financiero conocido, pero cambia la disponibilidad de nuevas voces reales de esta candidata. Está sin desplegar. No debe venderse como Audio completo ni fusionarse silenciosamente antes de decidir el contrato de reserva común. El progreso, autorización, audios previos y gasto permanecen conservados; no se reenvían llamadas inciertas.

No se seleccionan proveedores alternativos automáticamente: no hay prueba de autorización/equivalencia universal, y un saldo insuficiente no concede permiso a otro proveedor. La espera segura preserva el trabajo.

## Pruebas y reproducción

```sh
npm ci
# Herramientas locales oficiales ffmpeg + espeak-ng para fixtures Audio; NO voces reales.
npm run test:resource-sentinel
npx next typegen
npx tsc --noEmit --incremental false
```

El workflow nuevo `Resource Sentinel offline protection` ejecuta estas verificaciones sin secretos de proveedores. Los tests usan fixtures/dobles controlados, incluidos errores API,429, saldos insuficientes, alias compartidos, reservas simultáneas, caducidad, fallos del ledger y recuperación. El caso de caché real usa bytes sintéticos locales para comprobar el MP3, no una llamada real ElevenLabs. Los logs originales fallidos no se borran ni se convierten en PASS. Resultado y hashes definitivos se entregan en el respaldo privado posterior al commit.

## Integración y activación

Claude tiene reservado `src/app/dashboard/command-center/**`; ver `HANDOFF_CLAUDE.md` para el contrato HTTP y las etiquetas. Este PR no agrega otra UI, ledger, cola ni sistema de autorizaciones. No se fusiona ni despliega durante la implementación inicial: no se activó el nuevo scheduler contra producción. La cadencia actual no se da por cambiada hasta que se integre el workflow.

Antes de certificar activación: verificar los bindings existentes sin mostrar valores, cerrar/autorizar el contrato SQL compartido que aquí está fuera de alcance, terminar la UI administrativa con acceso restringido y validar observaciones reales gratuitas. Nunca usar una prueba fixture como evidencia de saldo/API/GPU reales.
