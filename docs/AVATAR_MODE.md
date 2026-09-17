# Modo Avatar — HeyGen + D-ID (arquitectura y estado real)

**Última verificación de la investigación de HeyGen: 2026-09-17. Comparación con otros proveedores (D-ID/Synthesia): 2026-09-17. Adaptador D-ID implementado (mock/tests, cero llamadas reales): 2026-09-17.**

Estado: **arquitectura, DOS proveedores (HeyGen y D-ID), UI y wiring del pipeline implementados y probados (fixture/mocks); ninguna llamada real fue posible con ninguno de los dos (sin `HEYGEN_API_KEY` ni `DID_API_KEY`).** El modo "visual" (existente) sigue siendo el único disponible para usuarios reales — `AVATAR_MODE_ENABLED=false` por defecto. **NI el adaptador HeyGen NI el adaptador D-ID deben considerarse production-ready** — ver "Lo que no se pudo confirmar" (HeyGen) y el comentario de cabecera de `providers/avatar/did.ts` (D-ID) — son bloqueos reales, no cosméticos.

## D-ID (`providers/avatar/did.ts`) — implementado este sprint, NO verificado

Mismo criterio de honestidad que HeyGen: implementado, con tests (`did.test.ts`, fetch mockeado, cero red real) y seleccionable vía `AVATAR_PROVIDER=did` + `DID_API_KEY`, pero el payload/response exacto de `/talks` y `/images`, el formato de autenticación Basic, y la forma del webhook **no se pudieron confirmar contra `docs.d-id.com`** (bloqueado en este entorno, igual que HeyGen) — son la mejor aproximación razonable a partir de las mismas fuentes secundarias citadas en la comparación de abajo. Diferencia arquitectónica clave frente a HeyGen: D-ID no tiene una fase de "entrenamiento" de avatar separada — `createAvatar()` solo sube la foto y devuelve `status: "completed"` de inmediato; `checkAvatarStatus()` es un no-op que siempre confirma "completed". No actives `DID_API_KEY` en producción sin confirmar tú mismo contra la documentación oficial primero.

## Limitación de investigación (léela antes de todo lo demás)

Este entorno de desarrollo tiene bloqueado por política de red el acceso a `docs.heygen.com` y `developers.heygen.com` (confirmado repetidamente al intentar leer la documentación oficial vía WebFetch, en dos sesiones de trabajo distintas — mismo bloqueo que OpenAI/Runway/Beatoven). No pude leer la fuente primaria directamente. Todo lo que sigue viene de búsquedas web (WebSearch) cuyos resultados citan o resumen páginas oficiales de `docs.heygen.com`/`developers.heygen.com`/`help.heygen.com` — cito la URL exacta de cada página fuente abajo, para que puedas abrirla tú mismo con una cuenta/browser real y confirmar.

## Hallazgo crítico: "Photo Avatar" ≠ "Digital Twin" — son productos distintos

Esta es la corrección más importante sobre la investigación anterior. Existen (al menos) dos productos de HeyGen que podrían mapear a "sube tu foto y que hable":

| | **Photo Avatar** | **Digital Twin** (también llamado "Video Avatar" / "Avatar IV") |
|---|---|---|
| Qué es | Según las fuentes, "depict no real, identifiable person" — parece más un personaje/estilo inspirado en la foto que una clonación garantizada de identidad | Clon hablante de una persona real e identificable — esto es lo que ATOMIVID describe en su especificación ("el usuario sube una fotografía propia... el avatar narra el guion") |
| Consentimiento exigido por HeyGen | No, según las fuentes | **Sí — un VIDEO de consentimiento grabado** (no un checkbox), de menos de 30s, con detección de vivacidad ("liveness detection"), enviado por upload/enlace de Drive, grabación en vivo por webcam, o QR desde el teléfono. Fuente: [Recording your Consent Video](https://help.heygen.com/en/articles/12092609-recording-your-consent-video), [Avatar Consent](https://developers.heygen.com/docs/avatar-consent) |
| Disponibilidad por API | Incluido en el plan self-serve "Creator" (pay-as-you-go), según fuentes | **Requiere el tier "Enterprise API"** — no self-serve, hay que contactar ventas de HeyGen. Fuente: búsqueda que cita [Enterprise Pricing](https://developers.heygen.com/docs/enterprise-pricing) |

**Consecuencia práctica:** el producto que técnicamente logra lo que ATOMIVID quiere (una persona real, identificable, narrando con su propia cara) es "Digital Twin", y ese requiere: (a) un flujo de consentimiento por VIDEO con detección de vivacidad — el checkbox de ATOMIVID NO es equivalente ni lo sustituye — y (b) el tier Enterprise de HeyGen, que implica contactar ventas y probablemente un contrato/mínimo, **fuera del alcance de "comprar créditos" que tenía autorizado**. No contraté nada — solo lo documento.

"Photo Avatar" sí es alcanzable con la API self-serve normal, pero no pude confirmar si de verdad preserva la identidad del usuario de forma reconocible o si es más una interpretación estilizada — esta ambigüedad **no se pudo resolver sin una cuenta HeyGen real**.

## Lo que SÍ se pudo confirmar (con fuente citada)

| Pregunta | Respuesta | Fuente citada por la búsqueda |
|---|---|---|
| Endpoints de creación | `POST /v3/avatars` (crear avatar), `POST /v3/videos` o `/v2/video/generate` (generar video), `GET /v3/videos/{id}` (estado), `GET /v3/voices` (voces) | [tryAGI/HeyGen OpenAPI (no oficial, reconstruido)](https://github.com/tryAGI/HeyGen/blob/main/heygen.yaml), resultados citando docs.heygen.com |
| Auth | Header `X-Api-Key` | Múltiples fuentes |
| Resolución/formato | 128–4096px, 1080p por defecto, 16:9 o 9:16 | Búsqueda citando [Usage Limits](https://developers.heygen.com/docs/usage-limits) |
| Límites | Video hasta 30 min; guion hasta 5000 caracteres | Misma fuente |
| Voces/idiomas | 300+ voces, 40+ idiomas | Búsqueda citando el índice de developers.heygen.com |
| Precio API | Pay-as-you-go, sin créditos gratis desde feb-2026, expiran a 12 meses, ~$0.99/crédito tier Pro o ~$0.50/crédito tier Scale | Búsqueda citando [HeyGen API Pricing Explained](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) |
| Webhooks | Recomendado, evento `avatar_video.success`; polling como alternativa | Múltiples fuentes |

## Lo que NO se pudo confirmar (bloqueo real, no cosmético)

1. **Si "Photo Avatar" preserva identidad reconocible** de forma confiable, o si es más una reinterpretación — sin esto, no puedo garantizar que el producto entregue lo que el usuario espera ("mi cara hablando").
2. **El payload/response exacto** de `POST /v3/avatars` y `POST /v3/videos` — lo implementado en `heygen.ts` es una mejor aproximación razonable (ver comentario en el propio archivo), no un contrato confirmado.
3. **Endpoint DELETE** para borrar un avatar o su foto fuente — ninguna fuente lo documenta explícitamente.
4. **Costo exacto del tier Enterprise** (Digital Twin) — nunca se publica sin contactar ventas.

**Por esto el feature flag permanece apagado y el adaptador no se presenta como listo para producción** — exactamente como se pidió. Activar esto en serio requiere: (a) una cuenta HeyGen real con acceso a `docs.heygen.com` para leer el contrato exacto, y (b) una decisión de producto consciente sobre Photo Avatar (self-serve, identidad no garantizada) vs. Digital Twin (Enterprise, identidad real, requiere ventas — fuera de mi autorización).

## Comparación de proveedores (para decidir si conviene sumar un segundo adaptador)

Igual que con HeyGen, `docs.d-id.com` está bloqueado por la política de red de este entorno — lo de abajo viene de WebSearch (resultados que citan/resumen la documentación oficial), no de lectura directa. Comparación acotada a lo relevante para ATOMIVID (foto única → video hablando, compatible con audio externo de ElevenLabs):

| | **HeyGen** (implementado) | **D-ID** (investigado, no implementado) | **Synthesia** (investigado, no implementado) |
|---|---|---|---|
| Ajuste al caso de uso exacto ("una sola foto → video hablando") | Ambiguo — ver arriba: "Photo Avatar" self-serve no garantiza identidad reconocible; el producto que sí la garantiza ("Digital Twin") exige tier Enterprise | **Es su producto central** ("Creative Reality Studio": foto → video hablando) — fuentes lo describen como la opción más fuerte específicamente para esto | Orientado a "avatares de stock"/plantillas para producción corporativa, no tanto a animar la foto propia del usuario |
| Consentimiento a nivel de API | Video de consentimiento con detección de vivacidad, pero SOLO exigido para Digital Twin (Enterprise) — no confirmado para Photo Avatar | Tiene un **objeto "Consent" propio en la API** (`POST /consents`, `GET /consents/{id}`) — más alineado con lo que ATOMIVID necesita documentar/auditar, aunque no se confirmó si es obligatorio antes de animar | No se investigó a este nivel de detalle |
| Audio externo (compatibilidad con ElevenLabs) | Sí — `voice.type: "text"` con `voice_id` propio; no se confirmó un modo "solo audio externo" (parece requerir generar la voz en el propio HeyGen) | Sí, confirmado — endpoint de subida de audio + `audio_url` apuntando a un audio ya generado (encaja mejor con "ATOMIVID ya sintetiza con ElevenLabs y solo necesita animar la cara") | No investigado |
| Webhooks | Mencionado (`avatar_video.success`) pero forma exacta no confirmada | Confirmado — campo `webhook` en la creación del talk | No investigado |
| SDK Node.js | REST directo (sin SDK oficial confirmado) | REST + SDK oficial de JavaScript confirmado | No investigado |
| Precio de entrada | Pay-as-you-go, ~$0.02-0.07/s (fuentes secundarias) | Plan API desde ~$5.90/mes (10 min), o ~$5.90/min pay-as-you-go según la fuente — cifras inconsistentes entre fuentes, sin confirmar | Desde ~$22/mes, pero orientado a licencias de asiento, no a costo por generación vía API |
| Riesgo de dependencia | El producto correcto (Digital Twin) requiere contrato Enterprise — riesgo de quedar atado a condiciones no autoservicio | Aparenta ser más autoservicio de punta a punta | Menos relevante para este caso de uso específico |

**Recomendación:** para el caso de uso exacto de ATOMIVID ("mi propia foto, que hable mi guion, con mi propia voz de ElevenLabs"), **D-ID parece un mejor ajuste que HeyGen** — es su producto central (no un caso límite como "Photo Avatar" de HeyGen), soporta audio externo de forma confirmada, y tiene un objeto de consentimiento propio en la API. **Se implementó un adaptador D-ID en un sprint posterior** (`providers/avatar/did.ts`, ver sección de arriba) exactamente como se anticipó: aditivo (un archivo nuevo + una entrada en el selector), sin tocar el pipeline ni la UI — pero, igual que HeyGen, sin verificar contra la documentación oficial primaria (sigue bloqueada en este entorno), así que tampoco es production-ready todavía.

## Arquitectura implementada

- `providers/types.ts`: `AvatarVideoProvider`, `AvatarProviderError` tipado, alias de producto (`PremiumVideoProvider`/`ImageGenerationProvider`/`MusicGenerationProvider`).
- `providers/avatar/heygen.ts`: adaptador — timeouts, reintentos finitos solo para errores recuperables, backoff acotado, circuit breaker, presupuesto verificado antes de gastar, límite de 5000 caracteres.
- `providers/avatar/circuit-breaker.ts`, `providers/avatar/fixture.ts`, `providers/avatar/index.ts`.
- `video/avatar/photo-validation.ts`: magic bytes reales, dimensiones, rechaza archivos disfrazados.
- `video/avatar/pipeline.ts`: ramificación real por `video_requests.mode` (ver "Wiring del pipeline" abajo).
- Migración `0011_video_modes_avatar.sql` (no aplicada, **verificada localmente contra Postgres real** — ver `supabase/migrations/verify/`).
- Migración `0013_avatar_state_taxonomy.sql` (no aplicada, additiva — añade `'draft'` a los CHECK de estado).
- `video/avatar/webhook.ts` + `app/api/webhooks/avatar/[provider]/route.ts`: recepción de webhook autenticada por secreto compartido.
- `/dashboard/new`: selector visual/avatar, carga de foto, consentimiento, estimación de costo (ver "UI" abajo).

## Wiring del pipeline (implementado)

`run-job.ts` lee `video_requests.mode` y, si es `"avatar"`, delega a `generateAvatarVideo()` (`video/avatar/pipeline.ts`) en vez de `generateVideoFromScript()`. Antes de llamar a ningún proveedor, verifica en este orden — cualquier fallo detiene el flujo sin llamar a HeyGen:

1. `AVATAR_MODE_ENABLED=true` (flag apagado → error claro, nunca una llamada).
2. El avatar referenciado (`avatar_id`) pertenece al mismo `user_id` de la solicitud (nunca confía en el id recibido).
3. `avatars.consent_given = true`.
4. `avatars.status` no es `'failed'` ni `'deleted'`, y el avatar ya tiene un `provider_avatar_id` asignado (si no lo tiene, se bloquea con "todavía no terminó de crearse en el proveedor").
5. El proveedor resuelto (`getAvatarProvider()`) está disponible (`isAvailable()`).
6. La narración estimada (palabras/2.5s) no excede `MAX_AVATAR_DURATION_SECONDS` (default 120s) — límite explícito de duración, independiente del tope de caracteres que cada proveedor pueda imponer por su cuenta.

Si algo falla, se registra un error sanitizado (nunca el contenido de la foto ni tokens) y la solicitud pasa a `failed` — igual que el modo visual ya hace hoy.

## Capacidades del contrato `AvatarVideoProvider` (ampliado en esta fase)

Además de crear/consultar/generar/borrar (ya documentado arriba), el contrato ahora exige:

- `estimateVideoCostUsd(request)`: estimación PURA (sin red) — usa la MISMA fórmula que `generateVideo()` usa internamente para rechazar por presupuesto, nunca una aproximación distinta que podría subestimar el gasto real (verificado por prueba: `heygen.test.ts`, "usa la MISMA fórmula que generateVideo").
- `cancelVideo(providerJobId)`: mismo criterio honesto que `deleteAvatar()` — intenta cancelar en el proveedor y reporta `{cancelled:false, reason}` si no se pudo confirmar, nunca finge éxito. **UNVERIFICADO para HeyGen** (sin endpoint de cancelación documentado).
- `processWebhookPayload(payload)`: normaliza un payload YA AUTENTICADO (la autenticación ocurre en la ruta HTTP, ver abajo) a `{providerJobId, status}` — devuelve `null` (nunca lanza) ante un payload malformado o de un evento no reconocido.

## Webhook (`POST /api/webhooks/avatar/[provider]`, implementado)

Notifica cuando un video de avatar termina (o falla) sin depender solo del sondeo — perder un webhook nunca cuelga una solicitud, porque `checkVideoStatus()` (sondeo) sigue funcionando en paralelo.

**Autenticación:** ningún mecanismo de firma de webhook de HeyGen pudo confirmarse contra la documentación oficial primaria — en vez de inventar una verificación que no se pudo confirmar, el endpoint exige un secreto compartido PROPIO (`AVATAR_WEBHOOK_SECRET`, que nosotros configuramos y le damos al proveedor al registrar la URL del webhook) en el header `X-Atomivid-Webhook-Secret`. Sin ese secreto configurado, o si no coincide, responde `401` **antes** de leer el cuerpo — nunca procesa un payload no autenticado. Si `AVATAR_MODE_ENABLED=false`, responde `404` sin revelar que la ruta existe.

Lógica de negocio separada en `video/avatar/webhook.ts` (`verifyWebhookSecret()`, `handleAvatarWebhook()`) — probada sin Supabase ni servidor Next.js reales; la ruta HTTP (`route.ts`) es una envoltura delgada, probada aparte para los caminos que nunca llegan a la base de datos (`route.test.ts`).

## UI (`/dashboard/new`, implementada)

Archivos: `page.tsx` (Server Component — lee `AVATAR_MODE_ENABLED` y, solo si está encendido, consulta los avatares `status='ready'` del usuario), `NewVideoForm.tsx` (Client Component — campos comunes + el selector de modo), `AvatarFields.tsx` (Client Component — campos exclusivos del modo avatar), `actions.ts` (Server Action — persistencia) y `validation.ts` (funciones puras de validación, compartidas por `actions.ts` y cubiertas por `validation.test.ts`).

Selector "Video visual" / "Video con avatar" — la opción avatar solo se **renderiza** si el servidor confirma `AVATAR_MODE_ENABLED=true` (nunca depende de una variable de entorno leída en el cliente); el propio servidor vuelve a rechazar `mode=avatar` en `actions.ts` si el flag está apagado, aunque alguien construya el POST a mano. Con el flag apagado (default), la página renderiza exactamente los mismos campos que antes de que existiera el modo avatar — cero control nuevo, cero regresión.

Con el flag encendido: selector para reusar un avatar ya `ready` o subir uno nuevo; carga de foto con vista previa client-side y validación de tipo/tamaño antes de enviar (la que de verdad decide es la validación server-side por magic bytes en `photo-validation.ts`); nombre interno del avatar; el idioma de la voz reusa el mismo `<select>` de idioma de narración del formulario (no hay un segundo selector de idioma redundante); selector de voz cuya lista está explícitamente marcada en la UI como "provisional" (no viene de `GET /v3/voices`, ver limitación arriba); estimación de costo de referencia antes de enviar; checkbox de consentimiento obligatorio (validado también en el servidor — `isAvatarConsentGiven()`) con enlace a `/terms#avatar-consent`, sección nueva con el texto completo; prevención de doble envío (mismo patrón `useFormStatus` que el formulario visual existente).

**Limitación conocida, documentada, no oculta:** al subir una foto nueva, `actions.ts` llama a `provider.createAvatar()` de forma síncrona dentro de la Server Action y exige que el resultado sea `status: "completed"` (mapeado a `avatars.status = 'ready'`) para poder usarlo de inmediato — si el proveedor devolviera un estado asíncrono (`queued`/`processing`), el usuario ve un error pidiendo reintentar más tarde, porque esta primera versión no implementa un seguimiento en segundo plano del avatar hasta que quede listo. El fixture y, según lo confirmado sobre "Photo Avatar", HeyGen responden de inmediato — pero esto no está garantizado si HeyGen cambia de comportamiento o si en el futuro se usa "Digital Twin" (genuinamente asíncrono).

## Estados (taxonomía)

`avatars.status`: `'draft'` (añadido en la migración 0013) `| 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted'`.
`video_requests.avatar_render_status`: `'draft'` (añadido en la migración 0013) `| 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'`.
`AvatarJobStatus` (TypeScript, contrato del proveedor): `'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'` — sin `'draft'`, porque ese estado es anterior a que exista cualquier job en el proveedor (nunca se le pregunta a HeyGen/D-ID por un job que ni siquiera se creó).

## Cómo activar (cuando tengas la clave Y hayas resuelto la ambigüedad Photo Avatar/Digital Twin)

```
AVATAR_MODE_ENABLED=true
AVATAR_PROVIDER=heygen
HEYGEN_API_KEY=...
MAX_AVATAR_COST_USD=3
MAX_AVATAR_DURATION_SECONDS=120
AVATAR_WEBHOOK_SECRET=<genera un valor aleatorio largo, regístralo también en el proveedor>
```

Ninguna de estas variables afecta el modo "visual" existente si no las configuras.
