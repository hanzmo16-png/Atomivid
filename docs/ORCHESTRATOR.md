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
   - «Deployment branches»: **«Selected branches»** con solo la rama por defecto. «Protected branches» se rechaza porque puede incluir otras ramas. Los workflows lo comprueban por API antes de escribir o usar un secreto. Un workflow subido en cualquier otra rama no podrá leer estos secretos.
   - Recomendado también: proteger la rama por defecto contra empujes directos. Quien pueda empujar a esa rama podría añadir un workflow que lea el entorno.
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
     - borra `ORCH_SECRETS_WRITER_TOKEN` del entorno; Hans lo revoca también en GitHub;
     - **siempre** borra `GOOGLE_OAUTH_REDIRECT` y `GOOGLE_OAUTH_PENDING`: también si un control falla antes y, con un paso `if: always()`, si el trabajo se cancela o caduca.
   - **Revocación:** Google revoca la concesión completa (este cliente y esta cuenta), no un token suelto. Por eso solo se revoca automáticamente el token de una cuenta que **no** es la dueña de la carpeta. Si algo falla con la cuenta dueña, no se guarda nada y el token ya guardado sigue funcionando. Para cortar el acceso: Cuenta de Google → Seguridad → Acceso de terceros.
   - **Token que escribe secretos:** se rechaza si es clásico (GitHub responde con `X-OAuth-Scopes`), si no caduca o si caduca dentro de más de 30 días.
   - **Amenazas cubiertas:**
     - el código no aparece en entradas públicas, registros ni resúmenes;
     - un código interceptado no sirve sin el verificador y el secreto del cliente, que solo existen como secretos;
     - no hay reutilización: el código es de un solo uso en Google y el intento se borra;
     - un estado que no corresponde, por mezcla de sesiones, se rechaza;
     - el token que escribe secretos es de grano fino, con permisos mínimos y vida corta, y se borra tras usarse;
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
  - La entrega corre en **otro trabajo**, con checkout e instalación limpios. Solo pasa `result.md` como salida del trabajo; no hay artefacto público. Nada de lo que Claude escriba en su espacio de trabajo se ejecuta junto al token de Drive.
  - El token del repositorio es de solo lectura y no se pide token OIDC (`id-token`).
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
   - aprobar la migración pendiente en un proyecto de Supabase **separado** y guardar `ORCH_SUPABASE_URL` y `ORCH_SUPABASE_SERVICE_ROLE_KEY` en el entorno. El orquestador ya no acepta las claves de producción de la app.
   - fijar `ORCH_STORE=supabase` y `ORCH_ALLOW_PAID_CALLS=true`;
   - lanzar con `GASTAR-HASTA-5USD`.
   - Recomendado: un límite de gasto del proyecto en el panel de OpenAI (USD 5) como respaldo independiente.
4. **Ejecutor automático de Claude (opcional):** ejecutar `claude setup-token`, guardar el resultado como `CLAUDE_CODE_OAUTH_TOKEN` y fijar `ORCH_CLAUDE_ACTION_ENABLED=true`.

## Secuencia de activación (cada paso lo autoriza Hans; en orden; con reversión)

Regla: no se pasa al siguiente paso hasta verificar el anterior. Todo es gratis salvo C3 (≤ USD 0.05) y D (≤ USD 5, aún NO-GO).

### A. PR #98: presupuesto del piloto (producción audiovisual)
| Paso | Qué autoriza Hans | Verificación | Reversión |
|---|---|---|---|
| A1 | Aplicar la migración `20261011040000_pilot_run_budget.sql` con el workflow «Aplicar migración de Supabase». Es aditiva y el código actual la ignora. | El workflow verifica el esquema antes y después. | Columna anulable y sin uso por el código anterior. Solo si hiciera falta, a mano en el editor SQL: `alter table public.podcast_episodes drop column run_budget_usd;` |
| A2 | Marcar #98 como listo y fusionarlo. Vercel despliega producción. Debe ir **después** de A1, para no frenar narraciones pagadas. | La página del episodio muestra «Máximo nuevo de esta ejecución». Una producción con la narración ya pagada arranca sin límite. Las programadas antes conservan su autorización. | «Instant Rollback» de Vercel al despliegue anterior, o revertir la fusión. Los datos son compatibles en ambos sentidos. |
| A3 | Opcional: `notice-check.yml`, `send` y luego `verify` (USD 0). | Que llegue la notificación al teléfono y Hans reaccione con 👍. | Nada que revertir: es un solo comentario. |

### B. PR #97: orquestador sin gasto
| Paso | Qué autoriza Hans | Verificación | Reversión |
|---|---|---|---|
| B1 | Crear el entorno `orchestrator` con «Selected branches» limitado a la rama por defecto, y Hans como revisor obligatorio (recomendado). Comprobar que **no** queda ninguna copia de los secretos de Google a nivel de repositorio. | Los workflows comprueban la política por API antes de usarlo. | Borrar el entorno, lo que borra también sus secretos. |
| B2 | Crear el proyecto de Google Cloud: API de Drive, pantalla de consentimiento «En producción» y cliente «Desktop app». Guardar sus dos secretos en el entorno. | — | Borrar el cliente OAuth, lo que invalida todos sus tokens. |
| B3 | Crear el token de grano fino `ORCH_SECRETS_WRITER_TOKEN`: solo este repositorio, «Secrets» y «Environments» de lectura y escritura, 7 días de vida. Guardarlo en el entorno. | `drive-oauth` rechaza un token sin caducidad o de más de 30 días. | Revocarlo en GitHub → Settings → Developer settings. |
| B4 | Fusionar #97. Probado: no afecta a producción. | La compilación no incluye ni ejecuta código del orquestador. | Revertir la fusión. |
| B5 | `drive-oauth` en modo `start` → consentimiento en el teléfono → guardar el secreto `GOOGLE_OAUTH_REDIRECT` en el entorno → `finish`. El flujo borra el token de B3 del entorno; Hans lo revoca también en GitHub. | Resultado «LISTO». `GOOGLE_OAUTH_PENDING` y `GOOGLE_OAUTH_REDIRECT` quedan borrados. | Cuenta de Google → Seguridad → Acceso de terceros → quitar la app (revoca el token). Borrar el secreto del entorno. |
| B6 | Fijar la variable `ORCHESTRATOR_ENABLED=true` y lanzar `orchestrator.yml` en modo `live` con el auditor simulado (USD 0). | Lee `Solicitudes/` y escribe en `Entregas/`; registro con 0 llamadas pagadas. | Interruptor de emergencia: `ORCHESTRATOR_ENABLED=false`. |

### C. Llamada de humo (≤ USD 0.05, una sola vez)
| Paso | Qué autoriza Hans | Verificación | Reversión |
|---|---|---|---|
| C1 | Crear un proyecto **dedicado** en OpenAI con límite de gasto. Guardar su clave como `ORCH_OPENAI_API_KEY` en el entorno. | — | Revocar la clave en el panel de OpenAI. |
| C2 | Fijar la variable `ORCH_ALLOW_PAID_CALLS=true` y lanzar el modo `preflight` (USD 0). | `wouldCall: true`, peor caso ≈ USD 0.0025, `previousSmokeDone: false`. | `ORCH_ALLOW_PAID_CALLS=false`. |
| C3 | **Autoriza el gasto:** lanzar `smoke` escribiendo `HUMO-0.05USD` y aprobar como revisor. | `SMOKE_CLAIM: claimed`, gasto ≤ USD 0.05, el proyecto enmascarado coincide con el de C1 y queda creada la etiqueta `orchestrator-smoke-claimed`. | `ORCH_ALLOW_PAID_CALLS=false`; revocar la clave. La etiqueta impide cualquier repetición. |

### D. Bucle pagado del piloto (≤ USD 5): todavía NO-GO
Requiere tres decisiones de Hans:
- dónde vive el almacén durable (recomendado: un proyecto de Supabase separado);
- su migración;
- `ORCH_STORE=supabase`.

Cada ejecución pagada lleva la frase `GASTAR-HASTA-5USD`.

### E. Ejecutor de Claude (opcional, USD 0 de API)
Hans guarda `CLAUDE_CODE_OAUTH_TOKEN` (de `claude setup-token`) en el entorno y fija `ORCH_CLAUDE_ACTION_ENABLED=true`. Reversión: poner la variable en `false` y borrar el secreto.

### Parada total, en cualquier momento
1. `ORCHESTRATOR_ENABLED=false` y `ORCH_ALLOW_PAID_CALLS=false`.
2. Borrar el entorno `orchestrator`.
3. Revocar la clave de OpenAI y el acceso de la app de Google.

