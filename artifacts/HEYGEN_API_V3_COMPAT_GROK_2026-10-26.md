# HeyGen API v3 — compatibilidad

Autor: Grok Bot / Grok
Fecha: 2026-10-26
Repositorio: https://github.com/hanzmo16-png/Atomivid
Base verificada: `claude/atomivid-mvp-setup-0079jv` @ `762714e2ff3d19a62d2c705b7487ff9a364677e7`
Rama: `cursor/heygen-api-v3-compat-5c53`
Presupuesto: USD 0. Ninguna llamada de pago a HeyGen. Ningún secreto de producción modificado.

Este informe es una auditoría y un parche simulado. No demuestra compatibilidad en vivo con HeyGen. La única prueba de contrato real sigue siendo una llamada autorizada y pagada, que aquí está prohibida.

## Defecto y riesgo

HeyGen retira v1 y v2 el 2026-11-01. La comparación oficial (https://developers.heygen.com/endpoint-version-comparison, leída el 2026-10-26) mapea `GET /v1/video.list` a `GET /v3/videos`.

El adaptador de avatar (`src/lib/providers/avatar/heygen.ts`) ya hablaba v3: `POST /v3/assets`, `POST /v3/videos` con `type: "image"` y `audio_asset_id`, `GET /v3/videos/{video_id}`, `GET /v3/users/me`. La hipótesis de “reescribir el proveedor” era falsa.

Quedaban dos huecos que sí rompen el contrato:

1. **Listado de conciliación obsoleto.** `heygenReconcileProbe` llamaba `GET /v1/video.list` y leía `data.videos[].video_id` más `data.token`. En v3 el cuerpo es `{ data: VideoDetail[], has_more, next_token }` y el identificador es `id`. Un cambio de URL sin cambiar el parser habría contado cero videos y podría leerse como “no hubo cobro”. El parser nuevo rechaza el sobre v1 (`warning.v3_endpoint` o `data.videos`) y no rellena la ventana de operaciones inciertas si la lista está incompleta, es 401/403, se agota el 429 o falla el transporte.
2. **Webhook mudo.** `processWebhookPayload` devolvía `null` para todo HeyGen. El simulador lo documentaba: un `avatar_video.success` oficial respondía 400. La documentación actual (https://developers.heygen.com/docs/webhook-events y https://developers.heygen.com/docs/webhooks) fija `event_type` + `event_data.video_id` y la firma HMAC-SHA256 del cuerpo crudo en el header `signature`. El receptor ahora acepta `avatar_video.success` y `avatar_video.fail`, ignora GIF/caption/traducción (no son el job de video) y verifica la firma solo si existe `HEYGEN_WEBHOOK_SECRET`. Ese secreto no se crea ni se rota aquí. Sin él, la firma oficial sigue en 401 y queda el header propio `X-Atomivid-Webhook-Secret`.

No se bajó resolución ni se añadió `engine`. El envío verificado sigue en `resolution: "720p"`, `aspect_ratio: "auto"`, sin TTS de HeyGen. `1080p` existe en la API; subirlo cambiaría el precio del sample ya observado y no es un arreglo de compatibilidad.

## Inventario

Clases: COMPATIBLE (contrato v3 vigente en código), OBSOLETA (llamada v1/v2 que había que migrar), RIESGOSA (puede cobrar dos veces, colgar o mentir el estado), NO VERIFICADA (no hay contrato primario suficiente, o no hubo prueba en vivo). “No aplica” = mención que no llama a HeyGen.

| Pieza | Llamada o contrato | Antes | Después |
|---|---|---|---|
| `src/lib/providers/avatar/heygen.ts` `upload` | `POST /v3/assets` | COMPATIBLE | COMPATIBLE. Acepta `asset_id` o `id`. |
| mismo, `generateVideo` | `POST /v3/videos` `type: "image"` + `audio_asset_id` | COMPATIBLE | COMPATIBLE. Un solo POST. 720p conservado. |
| mismo, sondeo / `recoverVideo` / `checkVideoStatus` | `GET /v3/videos/{video_id}` | COMPATIBLE | COMPATIBLE. `waiting`/`pending` → queued; `processing`; `completed`; `failed`; `cancelled` defensivo. Estado desconocido = error, no reintento de creación. |
| mismo, `getHeygenWallet` / `checkAvatarStatus` | `GET /v3/users/me`, `GET /v3/assets/{id}` | COMPATIBLE | COMPATIBLE |
| mismo, `processWebhookPayload` | eventos `avatar_video.success` / `avatar_video.fail` | OBSOLETA (siempre `null`) | COMPATIBLE en simulación |
| mismo, `cancelVideo` / `deleteAvatar` | sin DELETE que evite el cobro | NO VERIFICADA | NO VERIFICADA. No se inventó cancelación. |
| `src/lib/supply/heygen.ts` | `GET /v3/users/me` | COMPATIBLE | COMPATIBLE |
| `src/lib/ops/provider-config.ts` `heygenProbe` | `GET /v3/users/me` | COMPATIBLE | COMPATIBLE |
| mismo, `heygenReconcileProbe` | listado de videos | OBSOLETA `GET /v1/video.list` | COMPATIBLE en simulación: `GET /v3/videos`, campo `id`, cursor `next_token`. Fallo explícito si el sobre es legado o la página está incompleta. |
| `scripts/supply/observe.mjs` | `GET /v3/users/me` | COMPATIBLE | COMPATIBLE. Sin cambio. |
| `scripts/diagnose-avatar-request.ts` | `checkVideoStatus` → `GET /v3/videos/{id}` | COMPATIBLE | COMPATIBLE. Sin cambio. |
| `scripts/heygen-owner-trial.ts` y `diagnose-heygen-trial.ts` | usan el adaptador; no hay URL v1/v2 | COMPATIBLE | COMPATIBLE. Sin cambio. |
| `src/lib/video/avatar/heygen-audio.ts` | ffmpeg local a PCM WAV | COMPATIBLE (no es HTTP) | COMPATIBLE. Sin cambio. |
| `src/app/api/webhooks/avatar/[provider]/route.ts` | recepción | RIESGOSA: el payload oficial se descartaba | COMPATIBLE en simulación para el header propio y, si hay secreto, para `signature`. Activación en producción NO VERIFICADA. |
| `scripts/simulator/lib/fake-providers.ts` | falso `api.heygen.com` `/v3/*` | COMPATIBLE (simulado) | COMPATIBLE. El escenario AV-HG-08 ahora espera 200 + duplicado, no 400. |
| Podcast `visual: "avatar"` (`src/lib/podcast/v2/conversation.ts`, `video-jobs.ts`, `video-montage.ts`) | ninguna URL HeyGen | No aplica | No aplica. Control negativo. |
| Reel con avatar bloqueado (`src/lib/video/director/from-reel.ts`) | no llama a HeyGen; el plano aprobado se conserva | No aplica | No aplica. Control negativo. |
| Reel `mode: "avatar"` | la demanda de suministro nombra `heygen`; la ejecución es el mismo adaptador v3 | COMPATIBLE | COMPATIBLE. Sin llamada en la prueba de demanda. |
| Audio ElevenLabs → HeyGen | descarga del WAV propio y `audio_asset_id`; sin `script` ni `voice_id` | COMPATIBLE | COMPATIBLE. Cubierto en simulación. |
| Gestión `POST /v3/webhooks/endpoints` | no hay cliente que registre endpoints | NO VERIFICADA | NO VERIFICADA. No se registró nada (haría falta un secreto nuevo). |
| `docs/AVATAR_MODE.md` | cita histórica de `POST /v2/video/generate` como alternativa investigada en 2026-09-17 | Documento viejo, no es una llamada | Sin cambio. Hallazgo fuera de alcance. |

Conteo de llamadas HTTP HeyGen después del parche: **11 COMPATIBLE** (assets, create, get video, get asset, wallet del adaptador, wallet de suministro, probe de usuarios, listado v3, observe, diagnóstico por estado, trial vía adaptador), **0 OBSOLETA** en código ejecutable, **0 RIESGOSA** de doble POST en el adaptador, **3 NO VERIFICADA** (cancelar, borrar, alta de webhooks en la cuenta). Las menciones de podcast/reel sin HTTP no entran en ese conteo.

Antes del parche el conteo ejecutable era 10 COMPATIBLE, 1 OBSOLETA (`GET /v1/video.list`), 1 RIESGOSA (webhook que descartaba el evento oficial).

## Archivos cambiados

| Archivo | Por qué |
|---|---|
| `src/lib/ops/provider-config.ts` | Sustituye el listado v1 por `GET /v3/videos` y niega cobertura si la respuesta es ilegible. |
| `src/lib/ops/heygen-v3-list.test.ts` | Simula página v3, sobre legado, 401 y 429 acotado. |
| `src/lib/providers/avatar/heygen.ts` | Etiqueta `kind=auth` / `kind=rate_limit` sin reclasificar el POST como reintentable. Parsea el webhook oficial. |
| `src/lib/providers/avatar/heygen-v3-compat.test.ts` | Diez escenarios simulados. |
| `src/lib/video/avatar/webhook.ts` | Verificador HMAC del cuerpo crudo. |
| `src/app/api/webhooks/avatar/[provider]/route.ts` | Acepta la firma oficial solo para `heygen` y solo con `HEYGEN_WEBHOOK_SECRET`. |
| `src/app/api/webhooks/avatar/route.test.ts` | Firma mala → 401. Evento GIF firmado → 400, sin base de datos. |
| `scripts/simulator/scenarios/avatar.ts` | El callback duplicado ya no se espera como 400. |
| `package.json` | Incluye los dos archivos de prueba en `test:unit`. Choca de texto con otros PR que editan el mismo script; no se rebasó sobre ellos. |
| Este informe | Entrega para Drive. |

No se tocaron las ramas de los PR #199, #221, #222 ni #223. No hay migraciones, flags, secretos, ledger ni despliegue.

## SHA

Base: `762714e2ff3d19a62d2c705b7487ff9a364677e7`.

El SHA del HEAD de esta rama no puede imprimirse dentro del commit que contiene esta frase y seguir siendo verdadero. El cuerpo del PR copia `git rev-parse HEAD` después del push. Esa es la cifra de entrega.

## Pruebas

Todas simuladas. Ninguna afirma que HeyGen en vivo aceptó el contrato.

| # | Escenario | Dónde | Resultado local |
|---|---|---|---|
| 1 | Generación normal de avatar | `heygen-v3-compat.test.ts` | pasa. `POST /v3/videos`, 720p, persiste `video_id` antes del GET. |
| 2 | Video aún en proceso | mismo | pasa. `pending` → queued, `processing` → processing, cero POST. |
| 3 | Completado y descarga | mismo | pasa. Solo `video_url`. No GIF ni caption. |
| 4 | Fallo del proveedor | mismo | pasa. Un POST. El mensaje no arrastra la URL privada. |
| 5 | Timeout y relectura | mismo | pasa. El reloj de prueba corta el sondeo. Un POST. El GET posterior no crea. |
| 6 | Webhook duplicado | mismo + simulador AV-HG-08 | pasa en unidad. El duplicado y un `fail` tardío no bajan de `completed`. |
| 7 | Respuesta legado / incompatible | list test + compat test | pasa. Sobre v1 no es “lista vacía”. Estado `rendering` no crea otro video. 401 queda `kind=auth` y `upstream_error` (no se reclasifica como rechazo seguro de reintento). |
| 8 | Podcast con avatar | compat test | pasa. El campo visual no llama a HeyGen. |
| 9 | Reel con avatar | compat test | pasa. El plano bloqueado no llama a HeyGen. `mode: avatar` solo reserva el proveedor `heygen`. |
| 10 | Audio tipo ElevenLabs | compat test | pasa. Un download, `audio_asset_id`, sin `script` / `voice_id` / `engine`. |

Controles negativos: presupuesto o audio ausente siguen fallando antes de la red (`heygen.test.ts`); un POST ambiguo no se repite; la firma HMAC incorrecta responde 401; un evento GIF firmado no actualiza el job.

Comandos locales (USD 0): `npm run lint` (0), `npx next typegen && npx tsc --noEmit` (0 tras generar tipos), y la batería focal HeyGen/webhook/provider-config (43 pruebas, 0 fallos). `npm run test:unit` y el CI se anotan en el PR cuando terminan. Si el CI queda rojo, la causa se escribe allí; no se declara verde por anticipado.

## Riesgos que quedan

- Sin prueba pagada no hay compatibilidad en vivo. v1/v2 siguen vivos hasta el 2026-10-31; el parche no los llama.
- `HEYGEN_WEBHOOK_SECRET` no está puesto. Hasta que un humano registre `POST /v3/webhooks/endpoints` y guarde el secreto, HeyGen firmará entregas que este proceso rechaza. El sondeo `GET /v3/videos/{id}` sigue siendo la vía que completa el video.
- `listed: 0` con `failure` distinto de `null` no prueba que no hubo video. El script histórico `heygenReconcile` de `scripts/bigfoot-recovery-ops.ts` no se ejecutó y no se modificó.
- Tope de 20 páginas. Si `has_more` sigue, `failure: "incomplete"` y no se declara la ventana.
- La documentación no fija el orden del listado. Por eso ya no se corta al pasar una fecha: un corte temprano podía ocultar un video.
- `720p` se conserva a propósito. No es la resolución de los ejemplos `1080p` de la guía audio-to-video.
- Cancelar o borrar en HeyGen sigue sin un contrato que evite el cobro.
- `package.json` también lo editan #199, #221 y #223. Este diff solo inserta dos rutas de test. Habrá que combinarlo a mano si esas ramas entran antes.

## Hallazgos fuera de alcance (solo documentados)

- PR #223 (`claude/longform-arreglos-pendientes`, HEAD `23c25962ff0ea4457d051e1c53e446481ea987c4` en el preflight) sigue activo en Long Form y toca `package.json`. No se intervino.
- `docs/AVATAR_MODE.md` todavía describe, como investigación del 2026-09-17, `POST /v2/video/generate` junto a `POST /v3/videos`. No es código que se ejecute.
- La ambigüedad Photo Avatar / Digital Twin y el consentimiento por video de HeyGen siguen como estaban en `docs/AVATAR_MODE.md` y `docs/HEYGEN_OWNER_TRIAL.md`. No se reabrió ese producto.
- `scripts/bigfoot-recovery-ops.ts` puede marcar una operación histórica como `REFUNDED`. No se lanzó.

## Plan de reversa

Revertir el commit de esta rama. No hay migración, flag ni secreto que deshacer. El adaptador de creación ya era v3; revertir devuelve el listado a `GET /v1/video.list` (muere el 2026-11-01) y vuelve a descartar `avatar_video.success`. No reintenta jobs de producción.

## Veredicto

**GO para revisión humana de este borrador. NO-GO para fusión, despliegue, registro de webhooks o cualquier generación real.**

La revisión puede leer el diff y las pruebas simuladas. No puede dar por compatible la cuenta de HeyGen en producción.
