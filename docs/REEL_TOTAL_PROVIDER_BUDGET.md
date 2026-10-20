# Reel: presupuesto total de proveedores

Base: PR159, `94656bf62a198dff2b3c593cf55dd2164519450f`.
Preparado para auditoría; no activa proveedores, permisos ni un piloto pagado.

## Problema y protección

Una reserva de capacidad de USD 3.25 no impone un gasto final máximo de USD 1.50.
Las reservas por proveedor existentes se conservan. El nuevo control comprueba, antes de
cada admisión pagada, que **gasto confirmado + gasto incierto + máximo de la siguiente llamada
no supera el presupuesto del Reel**. Incluye guion, voz, imágenes y música del mismo proyecto,
en todos sus intentos. No suma dos veces las reservas de capacidad del job.

La acción de crear un Reel guarda `provider_spend_cap_usd` antes de la primera llamada de guion.
`REEL_MAX_PROVIDER_SPEND_USD` permite configurar el límite de nuevas solicitudes; el valor
predeterminado es USD 1.50. Una variable inválida bloquea la creación. Cambiarla después
no modifica las solicitudes existentes. El límite no puede elevarse, reducirse, borrarse ni
desvincularse cambiando el id o eliminando la solicitud. Otros campos siguen siendo editables.

La comprobación vive en `pi_submit_with_supply`, con el orden de bloqueos global → solicitud
que ya usa la reserva del job. Las llamadas simultáneas se serializan antes de sumar.
Una operación incierta sigue contando; no se borra ni se considera gratis. Un rechazo
devuelve una causa terminal y conserva guion, archivos y gastos previos.
Los proyectos con límite deben usar el UUID canónico en minúsculas: sus alias aceptados
por PostgreSQL (mayúsculas, llaves o sin guiones) se reconocen y rechazan antes de admitir
una llamada. Así el mismo Reel no puede abrir otro contador cambiando la escritura del ID.

El control limita las admisiones registradas a las tarifas configuradas. **No verifica contratos
del proveedor ni puede impedir que un proveedor facture una tarifa distinta.** No incluye
suscripciones, infraestructura ni impuestos. Esos precios deben verificarse antes del piloto.

## Aplicación y reversión

1. Auditar y probar `20261020150535_reel_provider_spend_cap.sql` en una base desechable.
2. Con autorización de producción: aplicar la migración **antes** del nuevo código.
3. Desplegar ambos cambios como una única versión operativa verificada.
4. Crear un Reel nuevo desde la cuenta piloto; no reutilizar una solicitud antigua sin límite.

La migración no rellena ni altera presupuestos de solicitudes antiguas (`NULL`); conserva su
comportamiento previo. No arregla por sí sola todos los costes de la plataforma. Si falta
la columna, la acción nueva rechaza la creación sin pagar ni continuar sin presupuesto.
Reversión operacional: detener el piloto y restaurar la aplicación previa, **conservando la
columna, el control y los datos de presupuestos ya abiertos**. No eliminar el control para
reanudar gasto. La versión previa crea solicitudes sin límite: no habilitar otro piloto con ella.

## Configuración propuesta del primer piloto

Primero: 30 s, guion ≤600 caracteres, material nuevo del Director con tope **0**, música
de la biblioteca existente. Conservar Director cinematográfico solicitado y su verificación;
no permitir sustitución silenciosa por montaje clásico.

- Vercel y worker: voz `0.20 USD / 1000 caracteres` (ya contrastada).
- `CINEMATIC_DIRECTOR_RENDER_ENABLED` y acceso piloto deben estar verificados en ambos.
- `VISUAL_DIRECTOR_ENABLED` es un planificador semántico distinto: no confundirlo con el motor cinematográfico.
- No activar compras de imágenes ni cambiar `DIRECTOR_MATERIAL_ENABLED` para esta prueba.
- Nuevo límite persistido: USD 1.50. Reserva temporal: calcularla desde la configuración
  efectiva; rechazar si supera el máximo que finalmente autorice Hans.

Con los supuestos originales (450 caracteres, storyboard 2.00, imágenes base 1.00,
material adicional 0.30), la reserva del job era 3.48, no 3.23. No reutilizar esa cifra
como reserva efectiva de producción. Este documento no cambia variables ni autoriza gasto.

## Pruebas y límites de evidencia

- Regresión del adaptador: antes daba `SupplyUnavailableError` y sugería una espera; los
  dos casos nuevos fallaron sobre la base. Después devuelve `ReelBudgetExceededError`.
- `test:spend` incluye pruebas de configuración y mensajes, además de los controles previos.
- `scripts/qa/reel-budget-postgres.ts` ejecuta las migraciones reales con PostgreSQL y
  conexiones separadas: 2/5/10 clientes, doble admisión, gasto incierto, frontera decimal,
  inmutabilidad, permisos, orden de bloqueos y conservación del presupuesto documental.
  También demuestra el ROJO con la función anterior. El ledger es sintético y el core de
  suministro se sustituye deliberadamente: esta prueba aísla la nueva barrera, no certifica
  la cadena completa de migraciones, Supabase alojado ni proveedores reales.
- CI: `.github/workflows/reel-budget-postgres.yml`, PostgreSQL 16.15 desechable sin secretos
  de producción. Un job sin ejecutar o fallido no se considera evidencia aprobada.
- Integración adicional: `scripts/qa/reel-budget-ledger-integration.ts` carga el DDL real del
  ledger de `9dccd68`, verificado por SHA-256, y diez migraciones de suministro sin modificar.
  Comprueba carreras entre proveedores, reservas del job de 3.25 frente al límite de 1.50,
  liquidaciones, exposición incierta, permisos, inmutabilidad, aliases del UUID, bloqueos por
  salud/saldo, conciliación y conservación del límite documental. El core de suministro de
  esta segunda prueba es el real; los saldos y las tablas padre de la aplicación son fixtures.
  No certifica una reconstrucción completa del esquema de producción: el DDL histórico está
  aislado en `scripts/qa/fixtures/`, con origen y hash, y no se añadió a las migraciones.
- El job `director-output` ejecuta el worker real con proveedores y Storage simulados. Comprueba
  MP4 H.264/AAC 1080×1920, decodificación completa, duración con la cola explícita de 0.5 s,
  MP4 y `director.json` del mismo intento, movimiento medido, rechazo sin presupuesto y
  duplicados. En el duplicado se vuelven a leer TODOS los archivos y se comparan sus hashes;
  la existencia de una lista previa de hashes no basta como prueba de conservación.
  También verifica rechazo del Director por divergencia de acceso, un 503 y un envío tardío.
  Los artefactos de CI identifican el SHA exacto, y conservan los logs y el video de fixtures.
- Este contenedor no permite un usuario PostgreSQL no root; no se simula esa ejecución como PASS.
  Además, el render local falló por `uv_interface_addresses`; no se alteró Remotion ni se ocultó
  ese fallo con una sustitución de interfaces de red. Estas comprobaciones se ejecutan en CI.

El MP4 de fixtures no es un piloto autenticado ni una compra a proveedores. La creación desde
la interfaz, Supabase alojado y la descarga desde la cuenta real siguen pendientes, junto con
la auditoría independiente y la autorización de migración, versión, configuración y gasto.
