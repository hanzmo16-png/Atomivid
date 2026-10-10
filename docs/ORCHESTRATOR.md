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
| `channel.ts` | Drive en memoria y por REST (Drive API v3), con token de una cuenta de servicio de Google. |
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

## Estimación de costos (modelo inicial `gpt-4.1-nano`)

Precios de lista según rastreadores de 2026: USD 0.10 por millón de tokens de entrada y USD 0.40 por millón de salida. Hay que verificarlos en openai.com antes de pagar.

| Escenario | Tokens | Costo |
|---|---|---|
| Auditoría típica | ~4 000 de entrada, ~300 de salida | ≈ USD 0.0005 |
| Peor caso reservado | 24 000 caracteres ≈ 8 000 tokens de entrada, 1 200 de salida | ≈ USD 0.0013 |
| Piloto: 40 llamadas/día durante 7 días | — | ≈ USD 0.36 en el peor caso |
| Tope USD 5 | — | ≈ 3 800 auditorías en el peor caso |

- **Claude:** no tiene costo de API en V1. El traspaso es por Drive, y el `claude-code-action` usa la suscripción Max mediante `CLAUDE_CODE_OAUTH_TOKEN`. No se asume API gratuita: sin ese token, el ejecutor no corre.
- **Google Drive:** la cuenta de servicio es gratuita.
- **Avisos de GitHub:** gratuitos.

## Qué falta para activarlo (acciones de Hans, gratuitas)

1. **Google:** crear una cuenta de servicio y compartir con su correo la carpeta de coordinación (permiso de editor). Guardar su JSON como secreto `GOOGLE_SERVICE_ACCOUNT_JSON` en GitHub, nunca en Drive.
2. **Variable `ORCHESTRATOR_ENABLED=true`:** permite ejecuciones manuales a USD 0 con el auditor simulado.
3. **Gasto del piloto:**
   - aprobar la migración pendiente y exponer el esquema `orchestrator`;
   - fijar `ORCH_STORE=supabase` y `ORCH_ALLOW_PAID_CALLS=true`;
   - lanzar con `GASTAR-HASTA-5USD`.
   - Recomendado: un límite de gasto del proyecto en el panel de OpenAI (USD 5) como respaldo independiente.
4. **Ejecutor automático de Claude (opcional):** ejecutar `claude setup-token`, guardar el resultado como `CLAUDE_CODE_OAUTH_TOKEN` y fijar `ORCH_CLAUDE_ACTION_ENABLED=true`.
