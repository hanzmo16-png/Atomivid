# ATOMIVID — Estado de continuidad (2026-09-17)

Documento vivo: qué está comprobado (no solo implementado), qué falta, y
cuál es el siguiente paso de mayor impacto. Actualizar en cada sesión
significativa en vez de crear un documento nuevo.

## 1. Migraciones — COMPROBADO en producción real

Las 13 migraciones (`0001`–`0013`) están **completamente aplicadas**,
confirmado por consulta directa a `information_schema`/`pg_catalog` (no
por inferencia REST). Verificación repetida (`run 35285746216`): `0
aplicada(s), 0 reconciliada(s), 13 ya registrada(s)` — cero SQL
re-ejecutado, mecanismo idempotente confirmado.

Mecanismo autónomo listo para migraciones futuras:
`.github/workflows/apply-supabase-migration.yml` — un solo
`workflow_dispatch`, sin pegar SQL a mano, sin secrets nuevos (el host del
Connection Pooler es un input no-secreto con valor confirmado por
defecto: `aws-0-us-west-2.pooler.supabase.com`).

## 2. Rama y despliegue — HALLAZGO IMPORTANTE, requiere tu confirmación

- **No existe una rama `main`** en `hanzmo16-png/Atomivid`. Las únicas
  ramas remotas son `claude/atomivid-mvp-setup-0079jv` (esta, con todo el
  trabajo de ATOMIVID) y dos ramas `codex/growth-engine-*` (foundation +
  dashboard) — **trabajo no relacionado** (un "planificador de campañas"/
  "bandeja de aprobación"), con commits tuyos directos (`hanzmo16@gmail.com`)
  encima de un punto histórico de esta misma rama. No los toqué.
- **La rama DEFAULT del repositorio en GitHub ES
  `claude/atomivid-mvp-setup-0079jv`** (confirmado: `list_commits` sin
  especificar rama devuelve el mismo HEAD que esta rama).
- **No tengo acceso a la API de Vercel en esta sesión** (sin
  credencial/herramienta expuesta) — no encontré `vercel.json` en el repo
  ni pude leer checks/deployments de Vercel vía GitHub. **No puedo
  confirmar qué commit está desplegado en producción.**
- Dado que no hay `main` y la rama default ES esta, es muy probable que
  Vercel esté configurado para desplegar directamente desde
  `claude/atomivid-mvp-setup-0079jv` — si es así, **los commits ya
  pusheados esta sesión pueden haberse desplegado automáticamente**, sin
  que yo lo supiera ni lo confirmara.
- **Necesito que confirmes**: (a) ¿cuál es la rama de producción real en
  Vercel?, (b) ¿qué son las ramas `codex/growth-engine-*` — trabajo en
  curso a preservar, o descartable?, (c) ¿quieres que cree una rama `main`
  formal para separar "producción" de esta rama de trabajo?

## 3. PR — NO preparado, depende del punto 2

No hay una rama base sensata contra la cual abrir un PR (no hay `main`).
Preparar un PR contra `codex/growth-engine-foundation` no tendría sentido
(rama no relacionada). En cuanto confirmes la rama de producción real,
preparo el PR con problema/cambios/pruebas/riesgos como se pidió.

## 4. Adaptador D-ID — corregido contra documentación oficial (parcial)

Acceso directo a `docs.d-id.com`/`www.d-id.com` sigue bloqueado
(`EGRESS_BLOCKED`, confirmado de nuevo este turno) — pero WebSearch
devolvió resultados que citan directamente páginas oficiales, suficientes
para corregir DOS bugs reales que habrían hecho fallar cualquier llamada
real desde el primer intento:

1. **Autenticación**: la API key es `usuario:contraseña`, el header debe
   ser `Basic <base64(usuario:contraseña)>` — el código anterior mandaba
   la clave cruda sin codificar. Corregido.
2. **Subida de foto** (`POST /images`): es `multipart/form-data` (campo
   `image`, solo jpeg/png) — el código anterior mandaba JSON. Corregido, y
   ahora se rechaza cualquier otro mimeType antes de gastar la llamada.
3. **Proveedor de voz obligatorio**: confirmado que D-ID exige
   `script.provider={type:"elevenlabs", voice_id}` para guion en texto —
   `generateVideo()` ahora exige `voiceId` explícitamente.
4. **Cancelación**: confirmado que `DELETE /talks/{id}` existe
   (`docs.d-id.com/reference/deletetalk`) — NO confirmado si detiene un
   render en curso o solo borra videos completados; se sigue tratando
   como best-effort.

Sigue sin confirmar (marcado explícitamente en el código): payload exacto
del webhook, límite de caracteres real, forma exacta del error. Precio:
~$0.0983/s según agregadores de terceros (no D-ID directamente).

**D-ID y toda generación pagada siguen apagados por defecto**
(`AVATAR_MODE_ENABLED=false`, `AVATAR_PROVIDER=fixture`,
`OPENAI_IMAGE_GENERATION_ENABLED=false`, `PREMIUM_CLIPS_ENABLED=false`).
Los tests con fetch mockeado prueban que el CÓDIGO hace lo esperado —
NUNCA prueban compatibilidad real con la API de D-ID.

## 5. Evidencia de los flujos con fixtures (esta sesión)

| Flujo | Estado | Evidencia |
|---|---|---|
| Video faceless completo | ✅ Real, verificado | `scripts/atomivid-test-output.mp4` — ffprobe confirma H.264 1080×1920 (9:16 correcto) + audio AAC 96kHz, 112s. Frame extraído muestra subtítulos quemados legibles. Enviado como artifact. |
| Imagen generada mezclada con stock | ✅ Real (a nivel resolver), parcial (a nivel Remotion) | `resolveGeneratedImageForScene()` invocado directamente con el proveedor fixture: genera `scene-0-generated.svg` (269 bytes, 1080×1920, costo $0), segundo intento reutiliza (idempotencia real, $0). **Limitación encontrada**: el storyboard *simulado* (`storyboard/simulate.ts`) siempre clasifica las escenas como `stock_video` — sin una llamada real a Claude, nunca se genera un video E2E con Remotion que mezcle imagen+stock. La lógica de decisión/mezcla SÍ está cubierta end-to-end por `visual-resource-planner.test.ts`/`visual-resource-resolver.test.ts` (parte de los 441 tests verdes). |
| Avatar: foto de prueba → video final | ⚠️ Orquestación real verificada; el "video final" en modo fixture NO es un archivo de video real | Script de verificación ejecutado con una foto JPEG real (800×800, generada con ffmpeg, pasó `validatePhotoBuffer`): confirmó consentimiento obligatorio, verificación de dueño (rechaza acceso cruzado entre usuarios), costo $0, e idempotencia (un job ya completado no se regenera). **Hallazgo real**: `fixtureAvatarProvider.generateVideo()` devuelve bytes de texto plano (`atomivid-fixture-avatar-video:...`), no un MP4 válido — al intentar masterizar el loudness, ffmpeg reporta `moov atom not found` (capturado en el log real de esta prueba) y el pipeline sube esos bytes igual (comportamiento ya documentado como aceptable — nunca falla el pipeline por eso). Por diseño ya documentado en el código, el modo avatar tampoco superpone subtítulos ni música (ninguna limitación nueva). |
| Subtítulos/audio/encuadre vertical/descarga | ✅ Confirmado (modo visual) | Ver fila 1. Botón "Descargar video" visible y funcional en la UI real (`/dev/states`, capturas enviadas). |
| Aislamiento entre usuarios | ✅ Confirmado en dos niveles | (a) Test de orquestación de esta sesión: acceso cruzado a un avatar ajeno rechazado con `avatar_not_owned`. (b) RLS confirmado EN LA BASE DE DATOS REAL por consulta directa a `pg_catalog` (no REST) durante la aplicación de migraciones: `avatars`/`video_requests`/`subscriptions`/`generation_costs` tienen RLS habilitado con policies "ver solo lo propio" — verificación autoritativa, no simulada. |
| Acceso privado a fotos/videos | ✅ Confirmado por código de migración | Bucket `videos` privado desde la migración 0006 (corrigió un bucket público anterior); bucket `avatar-uploads` privado desde su creación (migración 0011) — ambos ya aplicados y verificados en el punto 1. |

**Nota explícita**: ningún test con proveedor mockeado prueba
compatibilidad real con HeyGen/D-ID/OpenAI — solo prueban que el código
hace lo que el mock define.

## 6. UI — verificado en navegador real (Playwright, Chromium headless)

Página `/dev/states` (solo `next dev`, sin Supabase, con datos fijos)
capturada en escritorio (1440×900) y móvil (390×844) — enviada como
artifact. Confirma: layout responsivo, estados de solicitud (pendiente/
procesando/completado/error), reproductor vertical, botón de descarga,
modal de onboarding. **No se pudo capturar `/dashboard/new`** (formulario
real de creación, incluye el toggle de modo avatar) porque es una ruta
protegida por autenticación real — no se creó un usuario de prueba en el
proyecto real de Supabase para esto (habría tocado la base de datos de
producción sin autorización específica para ese propósito).

## 7. Próxima prueba pagada — preparada, NO ejecutada

Separada en dos pruebas independientes, autorizables por separado.

### 7a. Motor visual (imagen generada, OpenAI)
- Requiere: `OPENAI_API_KEY` real (no configurada en este entorno).
- Configuración mínima: `VISUAL_DIRECTOR_ENABLED=true`,
  `OPENAI_IMAGE_GENERATION_ENABLED=true`, `IMAGE_PROVIDER=openai`,
  `MAX_GENERATED_IMAGES_PER_VIDEO=1`, `MAX_VISUAL_COST_USD=0.10` (tope
  duro para esta prueba puntual).
- Costo estimado por la ÚNICA llamada necesaria: 1 imagen `gpt-image-2`
  a 1024×1536, calidad "medium" — **no se pudo reverificar el precio
  exacto contra la documentación oficial de OpenAI en este entorno**
  (mismo bloqueo de red); el valor ya configurado en
  `.env.example`/`pricing.ts` (`OPENAI_IMAGE_ESTIMATED_COST_USD=0.05`) es
  el último verificado en una sesión anterior — confírmalo tú antes de
  gastar si ha pasado tiempo.
- Llamadas máximas: 1 (una sola escena, un solo intento — sin reintentos
  automáticos en caso de fallo).
- Duración útil mínima para que la prueba diga algo: no aplica (una sola
  imagen estática, no depende de duración de video).

### 7b. Avatar (D-ID)
- Requiere: `DID_API_KEY` real (no configurada), y confirmar el plan
  contratado incluye ElevenLabs como proveedor de voz (documentado como
  función de pago en D-ID).
- Configuración mínima: `AVATAR_MODE_ENABLED=true`,
  `AVATAR_PROVIDER=did`, `MAX_AVATAR_COST_USD=1`,
  `MAX_AVATAR_DURATION_SECONDS=15` (tope bajo para esta prueba puntual).
- Costo estimado: ~$0.0983/s (fuente de terceros, NO D-ID directamente) ×
  ~10-15s de guion mínimo ≈ **$1-1.50 por intento**. Sujeto a error real
  al no poder confirmar el precio contra D-ID directamente.
- Llamadas máximas: 1 creación de foto (`POST /images`, sin costo
  reportado en las fuentes) + 1 talk (`POST /talks`) — sin reintentos
  automáticos.
- Duración útil mínima: ~10s de guion (suficiente para confirmar
  lip-sync/calidad sin gastar de más).
- **No se contrató ningún plan ni se habilitó consumo adicional** — esto
  es solo la especificación para cuando decidas autorizarlo.

## 8. Qué funciona en producción vs. solo en pruebas

- **En producción real (esquema de base de datos)**: las 13 migraciones,
  confirmado por consulta directa. El código de la aplicación (Next.js)
  — **no se pudo confirmar si está desplegado** (ver punto 2).
- **Solo verificado en pruebas/fixtures, nunca con un proveedor real**:
  guion (Claude), voz (ElevenLabs), footage (Pexels), imagen generada
  (OpenAI), video premium (Runway), avatar (HeyGen/D-ID) — todos con
  adaptador real implementado pero apagado por defecto, y ninguno
  ejecutado con una llamada real en esta sesión.
- **Limitación conocida, no nueva de esta sesión**: modo avatar no
  superpone subtítulos ni música (documentado en `pipeline.ts` desde su
  implementación original).

## 9. Confirmación de cero consumo pagado

Ninguna llamada real a Claude/ElevenLabs/Pexels/OpenAI/Runway/HeyGen/D-ID
en esta sesión. Todo lo generado (guion, voz, imágenes, "video" de
avatar) vino de proveedores `fixture`. La única red externa real usada:
`ip-ranges.amazonaws.com` (dato público, sin autenticación, sin costo) y
WebSearch/WebFetch para investigación de documentación (sin costo para
ATOMIVID).
