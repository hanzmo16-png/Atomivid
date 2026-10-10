# Orquestador de agentes de Atomivid (V1)

## Ciclo

1. Claude entrega en Google Drive el archivo `Entregas/<ID>__claude__hecha.md`.
2. El orquestador audita la entrega con OpenAI.
3. Según la decisión:
   - escribe una tarea nueva para Claude (`Solicitudes/<ID siguiente>__para-claude__revision-N.md`);
   - o cierra la tarea;
   - o pide la aprobación de Hans.
4. Se repite hasta completar la tarea o hasta que haga falta aprobación.
5. Cada cadena de tareas tiene como máximo 3 intentos automáticos. Después se bloquea.

- Canal: la carpeta de Drive «Atomivid-Coordinacion-Codex-Grok» con el protocolo v2 (`LEER_PRIMERO.md`).
- Firma del orquestador: `orquestador`.
- Solo atiende tareas con `orquestar: si` en el encabezado.

## Componentes (`src/lib/orchestrator/`)

| Archivo | Qué hace |
|---|---|
| `engine.ts` | Un ciclo con idempotencia, reintentos acotados, decisiones y registro de auditoría. |
| `openai-auditor.ts` | Adaptador de la Responses API (`POST /v1/responses`). Usa salidas estructuradas con esquema estricto, `store: false`, límite de tokens de salida y entrada recortada. |
| `simulated-auditor.ts` | Mismo contrato a USD 0, para pruebas y ejecuciones de demostración. |
| `budget.ts` | Libro de presupuesto propio. Reserva el peor caso antes de cada llamada y la liquida con el uso real. Aplica los límites por llamada, por ejecución, por día y el tope del piloto. |
| `config.ts` | Configuración, solo desde el entorno del servidor. Incluye el interruptor y las compuertas de pago. |
| `guard.ts` | Filtro determinista. Escala a Hans las entregas que se atribuyen autorizaciones y bloquea las instrucciones sensibles: gasto, producción, despliegue o fusión, credenciales, Travis Walton y la cuenta del editor de Grok. |
| `store.ts` | Almacén en memoria (pruebas), en JSON (local) y en Supabase. La migración de Supabase está en `supabase/pending/` y no se ha aplicado. |
| `channel.ts` | Drive en memoria y por REST (Drive API v3). Autentica con OAuth de usuario, token temporal o cuenta de servicio (esta última solo lee en un Drive personal). Exporta los Google Docs como texto. |
| `executors.ts` | Traspaso a Claude por Drive (por defecto). También el `claude-code-action` oficial, opcional y desactivado, y los avisos por mención de GitHub. |

Workflows:
- `orchestrator-probe.yml`: pruebas, demostración y presencia de credenciales. Es gratuito.
- `orchestrator.yml`: un ciclo, solo manual y con compuertas.
- `claude-executor.yml`: desactivado.

## Seguridad aplicada en el servidor

- **Interruptor de emergencia doble:** la variable `ORCHESTRATOR_ENABLED` y la marca `killed` en el almacén. Se comprueba al inicio y antes de cada llamada de pago.
- **Llamadas pagadas:** solo se hacen si se cumplen todas estas condiciones; si falta alguna, se usa el auditor simulado (USD 0).
  - `ORCH_ALLOW_PAID_CALLS=true`, como variable del repositorio que controla Hans;
  - la frase exacta `GASTAR-HASTA-5USD` escrita al lanzar el workflow;
  - `OPENAI_API_KEY` configurada;
  - precios configurados para el modelo;
  - un almacén durable.
- **Presupuesto del orquestador:** USD 5 como máximo. La configuración puede bajarlo pero nunca subirlo. Está separado de los gastos audiovisuales (`pi_paid_operations`).
- **Ningún archivo de Drive autoriza gastos.** El texto de Drive se trata como datos.
- **Repositorio y producción:** nunca fusiona ni despliega, y no toca la base de datos de producción de Atomivid.
- **Avisos:** son genéricos, con el ID de la tarea y sin datos privados. El repositorio es público.

## Modelo y precios (fuente oficial, consultada el 2026-10-10)

| Modelo | Entrada / salida por millón de tokens | Estado |
|---|---|---|
| **`gpt-5.6-luna`** (por defecto) | USD 0.20 / USD 1.20 | Sustituto que OpenAI indica para `gpt-4.1-nano`. Es un modelo de razonamiento: se pide esfuerzo bajo y los tokens de razonamiento se cobran como salida. |
| `gpt-5.4-nano` | USD 0.20 / USD 1.25 | Marcado como deprecado. |
| `gpt-4.1-nano` | USD 0.10 / USD 0.40 | Se apaga en la API el 23-oct-2026. El orquestador lo rechaza desde esa fecha. |

Fuentes: las páginas oficiales de cada modelo y la página de deprecaciones de developers.openai.com.

### Costo por llamada (`gpt-5.6-luna`)

| Escenario | Tokens | Costo |
|---|---|---|
| Auditoría típica | ~4 000 de entrada, ~600 de salida con razonamiento | ≈ USD 0.0015 |
| Peor caso reservado | 8 000 de entrada y 2 000 de salida | ≈ USD 0.0040 |
| Piloto: 40 llamadas/día durante 7 días | — | ≤ USD 1.12 en el peor caso |
| Tope interno de USD 5 | — | ≈ 1 250 auditorías en el peor caso |

**El tope interno no es un límite de facturación de OpenAI.** Lo aplica el orquestador con su propio libro: reserva el peor caso antes de cada llamada y liquida con el uso real. El límite real de cobro lo fija Hans en el panel de OpenAI (límite de gasto del proyecto). Son dos protecciones independientes.

### Identidad de la clave

La sonda gratuita (`GET /v1/models`, que no se factura) lee las cabeceras `openai-organization` y `openai-project` de la respuesta y las muestra enmascaradas, porque el registro es público. Hans puede comparar los primeros y últimos 4 caracteres con los del panel de OpenAI.

## Google Drive: autenticación

| Opción | Lee | Escribe en el Drive personal de Hans | Credencial |
|---|---|---|---|
| **OAuth de usuario** (recomendada) | sí | sí | Token de renovación de Hans con alcance `drive`, en los secretos de GitHub y revocable. |
| Cuenta de servicio (con o sin Workload Identity) | sí | **no** | Las cuentas de servicio no tienen cuota de almacenamiento en un Drive personal: solo sirven para escribir en una unidad compartida de Workspace. |
| Conector de Drive de claude.ai | sí | sí | Solo funciona dentro de sesiones de Claude, no en GitHub Actions. |

Pasos de Hans para la opción recomendada (una vez, sin pegar claves en chats):

1. **Proyecto en Google Cloud** (gratis):
   - activa la API de Google Drive;
   - pantalla de consentimiento externa, publicada «En producción» (en modo de prueba los tokens caducan a los 7 días);
   - crea un cliente OAuth de tipo «Desktop app».
2. **Asistente de consentimiento:** en su computadora, ejecuta `GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… npx tsx scripts/orchestrator/google-oauth-consent.ts`. Abre el consentimiento de Google y guarda los 3 secretos en GitHub con `gh secret set`, sin mostrarlos en pantalla.

## Ejecutor de Claude

- **Oficial:** `claude setup-token` genera un token de un año ligado a la suscripción Pro o Max (`CLAUDE_CODE_OAUTH_TOKEN`). Lo usa `anthropics/claude-code-action`.
- **Restricción documentada:** ese token solo hace peticiones al modelo. No sirve para Remote Control ni para los conectores de claude.ai. Por eso el workflow `claude-executor.yml` trae la tarea desde Drive y devuelve el resultado con `scripts/orchestrator/executor-io.ts`.
- **Uso compartido:** el consumo comparte los límites de uso del plan Max de Hans.
- **Riesgo conocido:** hay reportes públicos de errores 401 con este token en `claude -p`. Debe probarse en la primera ejecución.
- **Sin ese token no corre.** No hay respaldo con la API de pago.
- **Alternativa sin costo:** traspaso por Drive. Claude atiende `Solicitudes/` cuando Hans abre una sesión, o mediante una rutina que Hans programe en claude.ai.

## Primera llamada real (modo humo)

El workflow `orchestrator.yml` en modo `smoke` hace una sola auditoría real de una entrega fija e inocua:

- tope de USD 0.05;
- 1 llamada, sin reintentos;
- sin Drive y sin almacén durable.

Usa las mismas compuertas: `ORCH_ALLOW_PAID_CALLS=true` y la frase `GASTAR-HASTA-5USD` al lanzarlo. El costo esperado es de unos USD 0.001, y el peor caso reservado ronda USD 0.003.

## Qué falta para activarlo (acciones de Hans, gratuitas)

1. **Google:** seguir los dos pasos de OAuth de usuario descritos arriba. Así quedan los secretos `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` y `GOOGLE_OAUTH_REFRESH_TOKEN` en GitHub.
2. **Variable `ORCHESTRATOR_ENABLED=true`:** permite ejecuciones manuales a USD 0 con el auditor simulado.
3. **Gasto del piloto:**
   - aprobar la migración pendiente y exponer el esquema `orchestrator`;
   - fijar `ORCH_STORE=supabase` y `ORCH_ALLOW_PAID_CALLS=true`;
   - lanzar con `GASTAR-HASTA-5USD`.
   - Recomendado: un límite de gasto del proyecto en el panel de OpenAI (USD 5) como respaldo independiente.
4. **Ejecutor automático de Claude (opcional):** ejecutar `claude setup-token`, guardar el resultado como `CLAUDE_CODE_OAUTH_TOKEN` y fijar `ORCH_CLAUDE_ACTION_ENABLED=true`.
