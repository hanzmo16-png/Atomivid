# Modo Avatar — HeyGen (arquitectura y estado real)

**Última verificación de la investigación de HeyGen: 2026-09-17.**

Estado: **arquitectura, proveedor, UI y wiring del pipeline implementados y probados (fixture/mocks); ninguna llamada real fue posible (sin `HEYGEN_API_KEY`).** El modo "visual" (existente) sigue siendo el único disponible para usuarios reales — `AVATAR_MODE_ENABLED=false` por defecto. **El adaptador HeyGen NO debe considerarse production-ready** — ver "Lo que no se pudo confirmar" abajo, es un bloqueo real, no cosmético.

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

## Arquitectura implementada

- `providers/types.ts`: `AvatarVideoProvider`, `AvatarProviderError` tipado, alias de producto (`PremiumVideoProvider`/`ImageGenerationProvider`/`MusicGenerationProvider`).
- `providers/avatar/heygen.ts`: adaptador — timeouts, reintentos finitos solo para errores recuperables, backoff acotado, circuit breaker, presupuesto verificado antes de gastar, límite de 5000 caracteres.
- `providers/avatar/circuit-breaker.ts`, `providers/avatar/fixture.ts`, `providers/avatar/index.ts`.
- `video/avatar/photo-validation.ts`: magic bytes reales, dimensiones, rechaza archivos disfrazados.
- `video/avatar/pipeline.ts`: ramificación real por `video_requests.mode` (ver "Wiring del pipeline" abajo).
- Migración `0011_video_modes_avatar.sql` (no aplicada, **verificada localmente contra Postgres real** — ver `supabase/migrations/verify/`).
- `/dashboard/new`: selector visual/avatar, carga de foto, consentimiento, estimación de costo (ver "UI" abajo).

## Wiring del pipeline (implementado)

`run-job.ts` lee `video_requests.mode` y, si es `"avatar"`, delega a `generateAvatarVideo()` (`video/avatar/pipeline.ts`) en vez de `generateVideoFromScript()`. Antes de llamar a ningún proveedor, verifica en este orden — cualquier fallo detiene el flujo sin llamar a HeyGen:

1. `AVATAR_MODE_ENABLED=true` (flag apagado → error claro, nunca una llamada).
2. El avatar referenciado (`avatar_id`) pertenece al mismo `user_id` de la solicitud (nunca confía en el id recibido).
3. `avatars.consent_given = true`.
4. `avatars.status` no es `'failed'` ni `'deleted'`, y el avatar ya tiene un `provider_avatar_id` asignado (si no lo tiene, se bloquea con "todavía no terminó de crearse en el proveedor").
5. El proveedor resuelto (`getAvatarProvider()`) está disponible (`isAvailable()`).

Si algo falla, se registra un error sanitizado (nunca el contenido de la foto ni tokens) y la solicitud pasa a `failed` — igual que el modo visual ya hace hoy.

## UI (`/dashboard/new`, implementada)

Archivos: `page.tsx` (Server Component — lee `AVATAR_MODE_ENABLED` y, solo si está encendido, consulta los avatares `status='ready'` del usuario), `NewVideoForm.tsx` (Client Component — campos comunes + el selector de modo), `AvatarFields.tsx` (Client Component — campos exclusivos del modo avatar), `actions.ts` (Server Action — persistencia) y `validation.ts` (funciones puras de validación, compartidas por `actions.ts` y cubiertas por `validation.test.ts`).

Selector "Video visual" / "Video con avatar" — la opción avatar solo se **renderiza** si el servidor confirma `AVATAR_MODE_ENABLED=true` (nunca depende de una variable de entorno leída en el cliente); el propio servidor vuelve a rechazar `mode=avatar` en `actions.ts` si el flag está apagado, aunque alguien construya el POST a mano. Con el flag apagado (default), la página renderiza exactamente los mismos campos que antes de que existiera el modo avatar — cero control nuevo, cero regresión.

Con el flag encendido: selector para reusar un avatar ya `ready` o subir uno nuevo; carga de foto con vista previa client-side y validación de tipo/tamaño antes de enviar (la que de verdad decide es la validación server-side por magic bytes en `photo-validation.ts`); nombre interno del avatar; el idioma de la voz reusa el mismo `<select>` de idioma de narración del formulario (no hay un segundo selector de idioma redundante); selector de voz cuya lista está explícitamente marcada en la UI como "provisional" (no viene de `GET /v3/voices`, ver limitación arriba); estimación de costo de referencia antes de enviar; checkbox de consentimiento obligatorio (validado también en el servidor — `isAvatarConsentGiven()`) con enlace a `/terms#avatar-consent`, sección nueva con el texto completo; prevención de doble envío (mismo patrón `useFormStatus` que el formulario visual existente).

**Limitación conocida, documentada, no oculta:** al subir una foto nueva, `actions.ts` llama a `provider.createAvatar()` de forma síncrona dentro de la Server Action y exige que el resultado sea `status: "completed"` (mapeado a `avatars.status = 'ready'`) para poder usarlo de inmediato — si el proveedor devolviera un estado asíncrono (`queued`/`processing`), el usuario ve un error pidiendo reintentar más tarde, porque esta primera versión no implementa un seguimiento en segundo plano del avatar hasta que quede listo. El fixture y, según lo confirmado sobre "Photo Avatar", HeyGen responden de inmediato — pero esto no está garantizado si HeyGen cambia de comportamiento o si en el futuro se usa "Digital Twin" (genuinamente asíncrono).

## Cómo activar (cuando tengas la clave Y hayas resuelto la ambigüedad Photo Avatar/Digital Twin)

```
AVATAR_MODE_ENABLED=true
AVATAR_PROVIDER=heygen
HEYGEN_API_KEY=...
MAX_AVATAR_COST_USD=3
```

Ninguna de estas variables afecta el modo "visual" existente si no las configuras.
