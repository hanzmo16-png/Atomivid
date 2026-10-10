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

Pasos de Hans para la opción recomendada (una vez, sin pegar claves en chats ni en campos de workflows):

1. **Proyecto en Google Cloud** (gratis):
   - activa la API de Google Drive;
   - pantalla de consentimiento externa, publicada «En producción» (en modo de prueba los tokens caducan a los 7 días);
   - crea un cliente OAuth de tipo «Desktop app».
   - Opcional, para reducir el alcance: una cuenta de Google dedicada que sea dueña solo de la carpeta de coordinación, compartida con la cuenta principal. Si el token se filtrara, solo expondría esa cuenta.
2. **Entorno protegido de GitHub `orchestrator`** (Settings → Environments → New environment):
   - «Deployment branches»: solo la rama por defecto. Un workflow subido en cualquier otra rama no podrá leer estos secretos.
   - Recomendado: «Required reviewers» con Hans, para aprobar cada ejecución que los use.
   - Secretos del entorno:
     - `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET`;
     - `ORCH_OPENAI_API_KEY`, una clave **dedicada** de un proyecto de OpenAI propio con límite de gasto; nunca la `OPENAI_API_KEY` compartida de la app;
     - `ORCH_SECRETS_WRITER_TOKEN`, un token de GitHub de grano fino:
       - solo este repositorio;
       - permisos «Secrets» y «Environments» de lectura y escritura, y nada más;
       - caducidad de 7 días. Se borra al terminar.
3. **Autorización única desde el teléfono: workflow `drive-oauth.yml`.** Ninguna entrada del workflow lleva datos secretos.
   - **`start`:**
     - crea un intento aleatorio: un estado anti-CSRF y un verificador PKCE de 64 caracteres;
     - lo guarda como secreto del entorno `GOOGLE_OAUTH_PENDING`, válido 15 minutos y de un solo uso;
     - muestra el enlace de consentimiento, que solo lleva datos públicos: id del cliente, estado y reto PKCE.
   - **En el teléfono:**
     - Hans acepta. Si aparece «Google no verificó esta app», toca «Configuración avanzada» → «Ir a…»: la app es suya.
     - El navegador termina en una página de error `127.0.0.1`, como se espera.
     - Hans guarda la dirección completa como **secreto del entorno** `GOOGLE_OAUTH_REDIRECT`: cifrado y enmascarado, nunca un campo del workflow ni un chat.
   - **`finish`:**
     - exige un intento de menos de 15 minutos y el **mismo estado**, para que un código de otro consentimiento se rechace;
     - canjea el código con el verificador;
     - exige que la cuenta sea **dueña** de la carpeta de coordinación y pueda escribir en ella;
     - guarda `GOOGLE_OAUTH_REFRESH_TOKEN` en el entorno, pasando el valor por la entrada estándar;
     - revoca el token anterior;
     - **siempre** borra `GOOGLE_OAUTH_REDIRECT` y `GOOGLE_OAUTH_PENDING`.
     - Si algo falla, revoca el token nuevo y no guarda nada.
   - **Amenazas cubiertas:**
     - el código no aparece en entradas públicas, registros ni resúmenes;
     - un código interceptado no sirve sin el verificador y el secreto del cliente, que solo existen como secretos;
     - no hay reutilización: el código es de un solo uso en Google y el intento se borra;
     - un estado que no corresponde, por mezcla de sesiones, se rechaza;
     - el token que escribe secretos tiene permisos mínimos y vida corta;
     - el token de renovación queda en un entorno limitado a la rama por defecto.
   - Los workflows manuales solo se pueden lanzar cuando están en la rama por defecto.
   - **Descartado, según la documentación oficial de Google:**
     - el flujo de dispositivo no admite el alcance `drive`; solo `drive.file`, que no ve los archivos creados por los conectores de ChatGPT o Claude;
     - una cuenta de servicio o Workload Identity Federation no puede actuar como un usuario de Gmail;
     - el OAuth Playground obligaría a copiar el token a mano;
     - pegar el código en una entrada de un workflow público, que fue el diseño anterior.
4. **Alternativa con computadora:** `GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… npx tsx scripts/orchestrator/google-oauth-consent.ts`. Hace el retorno local en la propia computadora y guarda los secretos en el entorno `orchestrator` con `gh secret set`.

## Ejecutor de Claude

- **Oficial:** `claude setup-token` genera un token de un año ligado a la suscripción Pro o Max (`CLAUDE_CODE_OAUTH_TOKEN`). Lo usa `anthropics/claude-code-action`.
- **Restricción documentada:** ese token solo hace peticiones al modelo. No sirve para Remote Control ni para los conectores de claude.ai. Por eso el workflow `claude-executor.yml` trae la tarea desde Drive y devuelve el resultado con `scripts/orchestrator/executor-io.ts`.
- **Uso compartido:** el consumo comparte los límites de uso del plan Max de Hans.
- **Riesgo conocido:** hay reportes públicos de errores 401 con este token en `claude -p`. Debe probarse en la primera ejecución.
- **Sin ese token no corre.** No hay respaldo con la API de pago.
- **Aislamiento (revisión de seguridad):**
  - El orquestador lo despacha con `workflow_dispatch`, pasando el id de la tarea y la **huella sha256** del archivo que escribió.
  - El ejecutor solo corre esa tarea si hay exactamente un archivo con ese id, escrito por `de: orquestador`, con esa misma huella. Un archivo plantado o editado en Drive se rechaza.
  - Los secretos de Google solo llegan a los dos pasos de entrada y salida de Drive, nunca al paso de Claude.
  - Claude no tiene shell ni web, y el token del repositorio es de solo lectura.
  - La salida que se escribe en Drive pasa por un redactor de secretos: OpenAI, GitHub, Google (`GOCSPX-`, `ya29.`, `AIza`), Slack y claves privadas.
- **Alternativa sin costo:** traspaso por Drive. Claude atiende `Solicitudes/` cuando Hans abre una sesión, o mediante una rutina que Hans programe en claude.ai.

## Primera llamada real (modo humo)

El workflow `orchestrator.yml` en modo `smoke` hace una sola auditoría real de una entrega fija e inocua:

- tope de USD 0.05;
- 1 llamada, sin reintentos;
- sin Drive y sin almacén durable;
- **una sola vez por repositorio, con un control atómico:**
  - Justo antes de enviar, la ejecución **crea** la etiqueta `orchestrator-smoke-claimed`.
  - GitHub hace únicos los nombres de etiqueta: de dos ejecuciones concurrentes, solo una recibe 201 y la otra recibe 422. Cualquier otra respuesta también impide el envío.
  - La etiqueta nunca se borra sola. Borrarla a mano es la forma explícita de Hans para permitir otra llamada de humo.
  - **Capas adicionales:**
    - una re-ejecución (`GITHUB_RUN_ATTEMPT` > 1) nunca envía;
    - el grupo de concurrencia corre una sola ejecución a la vez;
    - se lee el historial completo, todas las páginas, y una ejecución titulada «Orchestrator smoke (paid)» que terminó en «success» bloquea las siguientes;
    - si el historial no se puede leer, no se envía nada.

Compuertas:
- `ORCH_ALLOW_PAID_CALLS=true`;
- la frase **propia** `HUMO-0.05USD` escrita al lanzarlo. La frase del piloto (`GASTAR-HASTA-5USD`) no autoriza el humo, y viceversa.

Costo: se esperan unos USD 0.001; el peor caso reservado es USD 0.0025 con `gpt-5.6-luna`.

**Proyecto de la clave:** la llamada registra, enmascarados, los encabezados `openai-project` y `openai-organization` de la respuesta, más el id de la petición. Sirven para que Hans confirme que la clave es del proyecto donde fijó el límite de gasto.

**Comprobación previa (USD 0):** el modo `preflight` evalúa todas las compuertas y el peor caso sin enviar nada. No recibe la clave, solo si existe. Puede lanzarse aunque `ORCHESTRATOR_ENABLED` no esté activado.

## Qué falta para activarlo (acciones de Hans, gratuitas)

1. **Google y entorno:** seguir los pasos de OAuth de usuario descritos arriba:
   - el proyecto de Google Cloud;
   - el entorno `orchestrator` con sus secretos;
   - `drive-oauth.yml` desde el teléfono, disponible una vez fusionado este PR.

   Así quedan `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` y `ORCH_OPENAI_API_KEY` en el entorno protegido.
   - **Antes de la llamada de humo:** lanzar `orchestrator.yml` en modo `preflight` (USD 0) y confirmar `wouldCall: true`.
2. **Variable `ORCHESTRATOR_ENABLED=true`:** permite ejecuciones manuales a USD 0 con el auditor simulado.
3. **Gasto del piloto:**
   - aprobar la migración pendiente y exponer el esquema `orchestrator`. Recomendado: un proyecto de Supabase **separado**, o un rol dedicado limitado a `orchestrator.state`. No conviene usar la clave de servicio del proyecto de producción de Atomivid.
   - fijar `ORCH_STORE=supabase` y `ORCH_ALLOW_PAID_CALLS=true`;
   - lanzar con `GASTAR-HASTA-5USD`.
   - Recomendado: un límite de gasto del proyecto en el panel de OpenAI (USD 5) como respaldo independiente.
4. **Ejecutor automático de Claude (opcional):** ejecutar `claude setup-token`, guardar el resultado como `CLAUDE_CODE_OAUTH_TOKEN` y fijar `ORCH_CLAUDE_ACTION_ENABLED=true`.
