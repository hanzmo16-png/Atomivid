# Auditoría profunda del flujo de guiones

Fecha: 17 de octubre de 2026, 19:16, Cancún (18 de octubre, 00:16 UTC).

## Dictamen

El problema no se limita a la calidad de la redacción ni a una API que ocasionalmente falla. El flujo corto no conserva una identidad durable del trabajo completo desde el primer envío hasta la entrega al navegador. Protege llamadas individuales, pero deja ventanas entre ellas, entre el cobro y el guardado, y entre el guardado y la respuesta HTTP. Además, generación, edición y regeneración aplican validaciones diferentes.

**No aprobar todavía la recuperación automática del flujo de guiones.** El PR #134 mejora el manejo de respuestas y tiempos, pero no cierra los defectos de esta ampliación. Diez escenarios problemáticos se reprodujeron, incluso con ese PR aplicado. No se ejecutaron generaciones reales ni se cambiaron filas, presupuestos, credenciales o producción.

Una prueba que confirma un defecto no demuestra que el producto esté arreglado. Las once pruebas de caracterización de este informe corresponden a diez defectos reproducidos y un control de autorización correcto.

## Base, método y límites

- Base publicada: `b9454219abd4d49f0516f319cf6182d5b2b335be`.
- PR #134 examinado: `d338d7b5e01f0e7bb7d112e93cda4705530740ef`; árbol `0ed7453467925ba33bf71766ef278d527856fa2b`, idéntico al árbol local probado.
- Se usan las funciones reales `withScriptGenerationContext`, `guardScriptLedgerCall`, `runScriptGeneration`, `persistScriptChange`, `safeParseJsonResponse` y los handlers reales `POST /script`, `PATCH /script` y `POST /script/regenerate-scene`.
- Se sustituyen autenticación, transporte, base de datos, proveedor y facturación por adaptadores en memoria. La red externa está negada. Las carreras se fuerzan mediante barreras de ejecución, sin esperas arbitrarias.
- Las rutas se prueban como handlers, sin servidor Next desplegado. El comportamiento de Postgres, los cortes reales de Vercel y las condiciones del proveedor requieren validación posterior controlada. No se afirma haber probado esos servicios reales en esta ampliación.
- La revisión previa de registros encontró intentos de guion inciertos. No permite calcular una tasa histórica de fallos ni atribuir retrospectivamente todos los incidentes a una única causa. No se publica telemetría privada en este documento.

## Recorrido y cobertura

| Etapa | Código examinado | Resultado |
| --- | --- | --- |
| Creación de solicitud | `dashboard/new/actions.ts`, `validation.ts` | Validación de tema, estilo, idioma y duraciones 30/60/90 antes del flujo; no es una prueba de calidad de la posterior respuesta. |
| Autenticación y cuota | Rutas de guion y `billing/quota.ts` | Hay control de propietario; parte de la preparación de rutas queda fuera del manejador de errores. La ruta de escena no repite `assertCanGenerate`; revisar explícitamente la política de derechos/cuota por regeneración. |
| Admisión económica | `supply/anthropic.ts`, `script-intent.ts`, `paid-calls/gate.ts` | Protección por operación individual; falta identidad y exclusión durable de la generación completa. |
| Llamada y corrección de longitud | `ai/script.ts` | Hasta tres iteraciones; el PR #134 guarda respuesta antes de parsear y comparte 40 s. La corrección recibe el conteo anterior, pero no el borrador que supuestamente debe corregir. |
| Validación de salida | `script-output.ts`, `script-quality.ts` | Mejoras en #134; reglas de forma y de calidad no son uniformes entre generación, PATCH y regeneración de escena. |
| Guardado | `script-generation.ts`, `script-persistence.ts` | CAS protege contra cambios durante la petición, no contra una pestaña que envía una versión antigua sin declararla. |
| Revisión y reintento | `ScriptReview.tsx`, `RequestCard.tsx`, `safe-json.ts` | Mensajes genéricos pueden invitar a repetir una operación ya realizada; se infiere el tipo de fallo a partir de texto y presencia de `script_json`. |
| Documental largo | `long-form/script-jobs.ts`, `documentary-script.ts`, `research.ts` | Tiene trabajo durable, token de propiedad y reuso de resultados por etapa. No comparte exactamente el diseño del Reel. Sus clientes Anthropic siguen sin timeout explícito frente a una ruta de 300 s; revisión estática, no reproducción de un corte real. |
| Avatar y podcast | Creación de solicitud y `podcast/server.ts` | Avatar con guion generado comparte el flujo corto. Grabación propia evita esa generación. El endpoint de podcast examinado recibe un guion o grabación del usuario: no es una llamada a Anthropic para redactarlo. No extrapolar los fallos del Reel a todo podcast. |

## Diez reproducciones

| ID / prioridad | Estímulo | Resultado observado | Criterio correcto para cerrar |
| --- | --- | --- | --- |
| R1 / P1 | El proveedor termina y el resultado se guarda; falla el guardado de `video_requests`; se repite la solicitud. | El resultado anterior existe, pero el nuevo intento usa `gen-1`: dos invocaciones y dos operaciones COMMITTED. | Reanudar el mismo trabajo y guardar el resultado ya pagado, sin otra llamada. |
| R2 / P1 | Se pausa A después de su primera respuesta COMMITTED, antes de corregir longitud; entra B; luego continúa A. | Secuencia de intenciones `gen-0`, `gen-1`, `gen-0`; tres invocaciones. | La exclusión debe durar toda la generación, incluidas correcciones, esperas y guardado final. |
| R3 / P1 | Una regeneración completa falla el control de calidad cuando ya existía un guion aprobado. | Se guarda `status=failed` y `script_json=null`. | Conservar la versión aprobada y guardar el nuevo borrador rechazado aparte. |
| R4 / P1 | Dos pestañas parten del mismo guion. A guarda; después B guarda su copia antigua con otra edición. | Ambos PATCH devuelven 200; B borra la edición de A. | Cliente envía versión esperada; servidor rechaza la escritura obsoleta con 409 y conserva ambas ediciones para revisión. |
| R5 / P2 | PATCH recibe `segments: [null]`. | TypeError sin respuesta JSON controlada del handler. | Validación de esquema antes de acceder a campos; respuesta 400 tipada. |
| R6 / P1 | PATCH recibe un título objeto y una escena con narración y búsqueda vacías. | 200 y datos inválidos guardados como guion listo. | Mismo contrato estructural para generar, editar y regenerar; ningún guion vacío puede quedar listo para render. |
| R7 / P1 | Regenerar una escena devuelve 150 palabras en un guion cuyo objetivo total es 83. | Ruta devuelve 200 con 205 palabras; el control global de calidad lo rechaza. | Revalidar el guion ensamblado y conservar el anterior si falla. El límite por caracteres no sustituye al de duración/calidad. |
| R8 / P2 | Falla la inicialización de autenticación en POST. | Excepción fuera del límite que produce respuestas JSON. | Límite de errores que incluya autenticación y carga, sin debilitar autorización. |
| R9 / P1 | El SDK representa rechazos HTTP 401, 403, 429 y 529. | En el código actual se convierten en RECONCILIATION_REQUIRED; un nuevo intento queda bloqueado. | Integrar una política por resultado demostrado, con errores de configuración distinguibles y reintentos limitados solo donde sean seguros. Mantener inciertos los desenlaces ambiguos. |
| R10 / P1 | Se guarda un guion correctamente pero se pierde la respuesta HTTP; el cliente recibe cuerpo vacío y sigue el mensaje de reintentar. | El parser aconseja repetir; la identidad nueva vuelve a invocar al proveedor. | Consultar o reanudar por ID de operación; diferenciar entrega de resultado y regeneración explícita. |

Control adicional: PATCH sobre una solicitud de otro propietario responde 403 y no modifica la fila. Los mocks no eliminan esa protección.

## Qué no cubrían las pruebas anteriores

El caso denominado «pestaña antigua» de `script-persistence.test.ts` pasaba al helper una versión esperada antigua. La ruta real vuelve a leer la versión actual del servidor al recibir el PATCH y no recibe la versión que tenía el navegador. El helper hace bien su CAS, pero ese test no ejercitaba el contrato HTTP completo. R4 reproduce ese recorrido y muestra la pérdida real en el modelo de datos simulado.

Análogamente, repetir la misma clave de operación reutiliza un resultado sin pagar. Esto no prueba que repetir un POST use esa clave: `decideScriptIntent` asigna otra generación después de un COMMITTED. R1 y R10 prueban esa diferencia.

La prueba de doble clic anterior mantenía la llamada del proveedor en vuelo. R2 la pausa después de COMMITTED. Es otra ventana y el bloqueo por llamada ya no basta.

## T32, PR #134 y trabajo previo

- **PR #134:** captura la respuesta antes de validarla, mejora diagnóstico, acota tiempo del proveedor y aplica admisión persistente a escenas. Sigue en borrador; esta auditoría no autoriza fusionarlo ni declara resueltos R1–R10.
- **T32:** se revisaron la entrega HTTP, la solicitud de corrección y el registro EN_PROCESO-1. Al consultar Drive a las 19:15 de Cancún solo apareció EN_PROCESO-1 para la corrección, no una entrega final verificable. Su objetivo es conservar exclusión durante las esperas por 429/529. Es necesario, pero no acredita exclusión durante todas las correcciones y el guardado final.
- Antes de combinar T32 con #134, probar que cada reintento respete el mismo plazo total, que no despache con un plazo ya agotado y que una espera no permita otro trabajo pagable. Releer y luego actuar sin un reclamo atómico deja una carrera.
- **PR #14:** el parche revisado incluye conservar borradores en un runner de muestras y dar el borrador previo al prompt de corrección. No es recuperación general de la ruta del producto. Evitar presentar ese trabajo antiguo como una solución ya integrada; portar únicamente lo compatible tras revisión.

## Hallazgos estáticos adicionales y mediciones pendientes

1. `ScriptReview.regenerateScene()` envía solo el índice y reemplaza todo el guion local con el devuelto por el servidor. No guarda primero los cambios manuales pendientes. Además, los botones Guardar y Generar final no bloquean por `savingIndex`, a diferencia del botón de regeneración completa. Hace falta una prueba de interacción de pérdida de ediciones/carrera; no se cuenta entre las diez reproducciones ejecutadas.
2. Las correcciones de longitud solicitan reescribir con un conteo anterior, sin incluir `lastScript`. Eso puede cambiar historia y metadatos o repetir un resultado de longitud incorrecta. Requiere editar el borrador concreto, conservarlo y medir convergencia.
3. Los 2.000 tokens cubren narración más todos los metadatos de escenas. No hay evidencia suficiente para atribuirles todos los fallos de producción. Medir por duración/idioma antes de modificar topes; no aumentar presupuesto a ciegas.
4. El plazo de 40 s de #134 excluye autenticación y parte del trabajo de base de datos. Si el guard tarda, `options()` puede devolver un timeout de 1 ms y aún llegar a invocar. Se necesita una decisión de admisión antes del envío y un estado inequívoco de «no enviado» al agotar el plazo; no confundirlo con incertidumbre tras envío.
5. Una cadena JSON como «No reintentes» gobierna parte de las acciones de recuperación. Guardar estados y códigos tipados, y construir la interfaz a partir de ellos. Los textos deben poder cambiar sin cambiar reglas de cobro.
6. No hay en esta auditoría un denominador fiable de todos los intentos históricos. Para hablar de «la mayoría», registrar intentos, operaciones, stop reason, tokens, etapas y latencias; no contar solicitudes actuales como si fueran intentos.

## Corrección estructural requerida

Mantener un trabajo de generación durable, con `generation_id`, propietario, solicitud, hash de entradas, revisión base, estado, etapa, token de propiedad y referencias a borradores/resultados. No implementar estos nombres como una migración improvisada: adaptar el contrato al esquema existente y revisar su compatibilidad.

Separar cuatro acciones: **consultar**, **reanudar**, **editar** y **regenerar explícitamente**. Reenviar la misma operación debe devolver su estado o resultado. Una regeneración nueva requiere una identidad nueva inequívoca. Un desenlace incierto no se convierte en «no cobrado» porque haya vencido un bloqueo.

El dueño del trabajo conserva la exclusión durante llamada, validación, correcciones, esperas y guardado. Las operaciones económicas conservan sus claves y consumos independientes. Guardar la respuesta cruda y el borrador validable antes de sustituir una versión aprobada. Un fallo de persistencia reanuda el guardado; un fallo de calidad conserva el borrador para edición. Ninguno debe producir un render accidental de contenido rechazado.

Unificar el esquema estructural del guion y la validación del resultado ensamblado. El PATCH lleva revisión esperada. La interfaz conserva cambios pendientes, consulta un trabajo que perdió su respuesta y distingue espera, rechazo editorial, fallo técnico e incertidumbre económica.

## Orden de ejecución y criterios de aceptación

1. Revisar T32 entregado y combinarlo con #134 en una rama aislada; ejecutar las carreras entre llamadas y durante ambas esperas, con 429 y 529, sin invocar proveedores reales.
2. Implementar identidad durable y recuperación del resultado pagado. Cortar antes/después de enviar, antes/después de guardar resultado, antes/después de COMMITTED, antes/después de guardar guion y antes de entregar HTTP. Demostrar que no se duplica una operación completada ni se reenvía una incierta.
3. Conservar versiones y corregir el contrato de edición/revisión. Convertir R3–R8 en pruebas de aceptación que exijan conservación, rechazo tipado y versión correcta.
4. Probar interacción real de dos pestañas, edición pendiente durante regeneración, recarga y pérdida de respuesta. Cubrir 30/60/90 s, español/inglés, respuesta truncada/vacía, JSON/esquema inválido, rechazo editorial, límites de presupuesto, errores de almacenamiento y de autenticación. No declarar cubiertas esas combinaciones solo por el conteo de pruebas unitarias.
5. Validar el conjunto integrado, revisar migración y rollback si se necesitan, y solo después plantear una prueba real con presupuesto y versión desplegada identificados. Esta auditoría no ejecuta ese despliegue ni ese gasto.

## Evidencia reproducible

```bash
node --experimental-test-module-mocks --import tsx --test scripts/audits/script-recovery-probes.test.ts
npm run typecheck
npx eslint --no-ignore scripts/audits/script-recovery-probes.test.ts
```

Entorno utilizado: Node 24.19.0 y dependencias del lockfile del repositorio. `mock.module` es experimental; el comando anterior lo habilita explícitamente. Resultado de las sondas: **11/11 ejecutadas, diez defectos confirmados y un control correcto**, no once reparaciones. La suite de 168 pruebas de #134 sigue siendo evidencia separada, de alcance limitado.

La causa exacta de un incidente antiguo sin respuesta recuperable sigue siendo desconocida. Esta auditoría entrega causas reproducibles y criterios para eliminarlas, no una atribución retrospectiva inventada.
