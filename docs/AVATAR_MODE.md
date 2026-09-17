# Modo Avatar — HeyGen (arquitectura y estado real)

Estado: **arquitectura y proveedor implementados y probados con mocks; ninguna llamada real fue posible (sin `HEYGEN_API_KEY`); UI y wiring del pipeline pendientes.** El modo "visual" (existente) sigue siendo el único disponible para usuarios reales — `AVATAR_MODE_ENABLED=false` por defecto.

## Limitación de investigación (léela antes de todo lo demás)

Este entorno de desarrollo tiene bloqueado por política de red el acceso a `docs.heygen.com` y `developers.heygen.com` (confirmado al intentar leer la documentación oficial vía WebFetch — mismo bloqueo que OpenAI/Runway/Beatoven). Todo lo que sigue viene de **búsquedas web que citan o resumen la documentación oficial** (varias fuentes independientes, sep 2026), no de una lectura directa de la fuente primaria. Antes de activar `HEYGEN_API_KEY` en producción, confirma esto tú mismo contra <https://docs.heygen.com> y <https://developers.heygen.com>.

## Hallazgos (Paso 4 de la especificación)

| Pregunta | Respuesta (fuente secundaria, no verificada contra primaria) |
|---|---|
| ¿Existe API para avatar desde una sola foto? | Sí — "Photo Avatar" (`avatar_type: "photo"`), `POST /v3/avatars` |
| ¿Requiere consentimiento por API? | Según las fuentes, **no** para avatares tipo "photo" (sí para "digital twin", vía `POST /v3/avatars/{group_id}/consent`) — **Atomivid exige consentimiento del usuario en los dos casos de todas formas**, como política de producto independiente de lo que HeyGen exija técnicamente |
| ¿Qué plan requiere? | Desde feb-2026, la API es pay-as-you-go prepago (créditos USD), sin créditos gratis — no ligado al plan de suscripción de la web app |
| Formatos/resolución | 128–4096px, 1080p por defecto, 16:9 o 9:16 soportados |
| Límite de duración | Video hasta 30 min; texto de guion hasta 5000 caracteres por solicitud |
| Idiomas/voces | 300+ voces, 40+ idiomas (`GET /v3/voices`) |
| Sincronización labial | Sí, incluida en la generación de video con avatar |
| Webhooks/polling | Ambos — webhook recomendado (`avatar_video.success`), polling como alternativa |
| Costos | ~$0.0167–$0.0667 por segundo de video con avatar, créditos expiran a los 12 meses |
| Eliminar avatar/foto vía API | **No se pudo confirmar un endpoint DELETE documentado** en las fuentes disponibles — `heygenAvatarProvider.deleteAvatar()` intenta un `DELETE` best-effort y siempre reporta honestamente `deleted:false` con motivo si no puede confirmarlo, nunca finge éxito |

## Arquitectura implementada

- `providers/types.ts`: `AvatarVideoProvider` (interfaz), `AvatarProviderError` (tipado, incluye `consent_missing`/`circuit_open`), `PremiumVideoProvider`/`ImageGenerationProvider`/`MusicGenerationProvider` como alias de los proveedores ya existentes (Runway/OpenAI/Beatoven — mismo tipo, sin duplicar lógica).
- `providers/avatar/heygen.ts`: adaptador real — timeouts, reintentos finitos SOLO para errores recuperables (429/5xx), backoff exponencial acotado, circuit breaker (abre tras 3 fallos consecutivos en la misma ejecución), verificación de presupuesto antes de gastar, validación del límite de 5000 caracteres.
- `providers/avatar/circuit-breaker.ts`: utilidad genérica, probada en aislamiento.
- `providers/avatar/fixture.ts`: ciclo de vida completo determinístico (sin red).
- `providers/avatar/index.ts`: selector — sin `AVATAR_PROVIDER=heygen` + `HEYGEN_API_KEY`, cae a fixture.
- `video/avatar/photo-validation.ts`: valida MIME real (magic bytes, no el declarado por el navegador), tamaño, dimensiones (PNG/JPEG exactas; WEBP solo por tipo, limitación documentada) — rechaza archivos disfrazados (Content-Type declarado que no coincide con el contenido real).
- Migración `0011_video_modes_avatar.sql` (no aplicada): `video_requests.mode`, tabla `avatars` con consentimiento/retención/RLS, `idempotency_key` único, desglose de costo en `generation_costs`.

## Qué falta (próxima iteración, no incluido aquí)

1. **UI** (`/dashboard/new`): selección visual/avatar, carga de foto con vista previa, checkbox de consentimiento, estimación de costo antes de generar.
2. **Wiring del pipeline**: `run-job.ts`/`generate-video.ts` todavía no ramifican por `video_requests.mode` — el modo avatar existe como proveedor aislado y probado, pero no está conectado al flujo de generación real.
3. **Ruta de subida de foto**: endpoint API que reciba el archivo, lo valide con `photo-validation.ts`, lo suba a un bucket privado nuevo (`avatar-uploads`, con URLs firmadas de expiración corta), y dispare `createAvatar()`.
4. **Webhook de HeyGen**: `heygen.ts` implementa solo polling — el webhook (recomendado por las fuentes) requiere una ruta pública verificable, no incluida aún.

## Cómo activar (cuando tengas la clave)

```
AVATAR_MODE_ENABLED=true
AVATAR_PROVIDER=heygen
HEYGEN_API_KEY=...
MAX_AVATAR_COST_USD=3
```

Ninguna de estas variables afecta el modo "visual" existente si no las configuras.
