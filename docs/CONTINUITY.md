# ATOMIVID — Estado de continuidad (2026-09-18)

Documento vivo: qué está comprobado (no solo implementado), qué falta, y
cuál es el siguiente paso de mayor impacto. Actualizar en cada sesión
significativa en vez de crear un documento nuevo.

## Estado verificado — integración y migración 2026-09-18

- PR #2 integrado en la rama de trabajo; PR #1 integrado en la rama principal.
- Commit de integración: `158bff34d65279a8ce3c82cad6017e2c05bf7aa4`.
- 454 pruebas unitarias, TypeScript y 6 pruebas adicionales del diagnóstico D-ID aprobadas.
- CI E2E completo (avatar y mezcla con fixtures) exitoso: run `35302092477`.
- Migración 0014 aplicada realmente y verificada por SQL (tipo timestamptz,
  nulabilidad y registro en `_migrations_applied`): run `35302350933`, job `105467440720`.
  Resultado: 1 aplicada, 0 reconciliadas, 0 reaplicadas.
- Vercel devolvió `success` para el commit de integración:
  https://vercel.com/atomivid/atomivid/7GNKwvBJRiTFsT14nA7HLYFYunWP
  No se verificó el alias/dominio de producción porque el panel requiere inicio de sesión.
- Diagnóstico D-ID en Actions: `configured:false`, `authenticated:false`, `reason:missing_key`.
  No hay `DID_API_KEY` disponible para ese workflow; no se realizó una llamada al proveedor.
- Inicio de sesión de D-ID por navegador bloqueado por credenciales rechazadas.
  No registrar credenciales ni fotos en este repositorio. Sin avatar real ni consumo pagado.

Siguientes dependencias: resolver acceso a D-ID y sus créditos/tarifa; configurar
la clave mediante un canal seguro; alinear configuración de avatar en Vercel y
el worker (render.yml aún no pasa variables de avatar); medir audio real antes del
POST. La recuperación automática de resultados por ID sigue pendiente: nunca
liberar una reserva ambigua ni regenerar para recuperar un resultado perdido.
La autorización del propietario cubre integración, despliegue, migración y prueba
con su foto; mantener el límite previo de USD 10 y no contratar suscripciones.

Las secciones siguientes son historial; prevalece este estado verificado.

## Continuación Codex — narración obligatoria (2026-09-18)

- CI del commit anterior confirmado exitoso: run 35293882731, ambos
  renders completos con fixtures y publicación de evidencia.
- El pipeline detiene la generación si falla la síntesis, subida o firma
  del audio propio; no activa TTS interno como fallback.
- Un job existente se consulta antes de sintetizar voz nuevamente.
- Un avatar sin ID de proveedor se rechaza antes de sintetizar voz.
- Errores de narración no exponen mensajes del proveedor o URLs privadas.
- Validación: cuatro pruebas nuevas de regresión (síntesis, subida, firma
  y reintento sin repetir voz). Suite 446/446, TypeScript y ESLint correctos
  tras generar tipos de rutas con next typegen.
- Pendientes: reclamo persistente del intento antes del POST, recuperación
  del resultado existente, duración medida, costo real y prueba con foto de Hans.
  Estas correcciones NO garantizan todavía ejecución pagada única.
- Sin llamadas pagadas, migraciones ni activación del modo avatar.

## Actualización Codex — 2026-09-18

- Acceso al repositorio confirmado; punto de partida PR #1, `5d323cc`.
- Nuevo workflow `.github/workflows/e2e-fixture-evidence.yml`: ejecuta avatar
  y mezcla con fixtures, sin secrets, verifica decodificación/audio/9:16 y
  publica artifacts durante 14 días. Se activa al actualizar código del PR.
- Eliminada ruta de Chromium propia del entorno de Claude; Remotion obtiene
  su navegador en CI. El sandbox local no pudo descargarlo (timeout del proxy),
  por lo que el render visual de esta revisión debe verificarse en GitHub.
- Corregidos tests: voz fixture explícita; argumento posicional de foto sin
  `--out-dir`; presencia de stock comprobada por archivos subidos; ffprobe
  ahora falla la prueba si el video no es válido y ffmpeg decodifica el archivo.
- Validación local: 442/442 unitarias, TypeScript y ESLint correctos. Avatar E2E
  ejecutado: 720x1280, audio presente, 6.014 s, decodificación completa exitosa.
- `docs/AVATAR_MODE.md` actualizado; `docs/AVATAR_REAL_TEST.md` detalla foto,
  carga privada y fuentes oficiales. Precio exacto y cuenta D-ID sin confirmar.
- GitHub sí devuelve un check Vercel exitoso para el commit BASE `48c8b496`:
  https://vercel.com/atomivid/atomivid/CJ8pmi4AENqMMVbUnven5r6Y9pkN
  Esto no identifica de forma concluyente el commit del dominio de producción.
- La prueba REAL sigue sin ejecutar y debe usar la foto de Hans. El mecanismo
  pagado de intento único aún requiere implementación: hay fallback a TTS interno
  y duración estimada por palabras; no equivalen a un tope monetario garantizado.
- No reaplicadas migraciones, ni fusionado PR, ni contratado servicios.

La sección de traspaso anterior se conserva como historial; para los pendientes
actuales prevalece esta actualización y el resultado del workflow del nuevo commit.

## 0. Traspaso — léeme primero si continúas este trabajo (2026-09-18)

**Rama de trabajo**: `claude/e2e-verification-scripts` (PR #1 hacia
`claude/atomivid-mvp-setup-0079jv`, sin fusionar). Todo lo de esta
sección ya está **commiteado y pusheado** ahí, en tres commits:

1. `02f6306` — corrige el contrato D-ID `audioUrl`/`voiceId` (el flujo
   real de ATOMIVID usa audio propio ya sintetizado con ElevenLabs, NO
   la síntesis interna de D-ID salvo que falte `audioUrl`) + corrige el
   texto de `cancelVideo()` para no presentar `DELETE /talks/{id}` como
   cancelación/ahorro de cargos (sin respaldo documental para esa
   afirmación).
2. `71f57f9` — reemplaza los bytes falsos del proveedor fixture de
   avatar por un MP4 real y válido (h264 720×1280, aac, 6s) con "VIDEO
   SIMULADO" incrustado en los fotogramas — generado con ffmpeg
   (`testsrc2`+`sine`), **sin ningún rostro real ni de stock**.
3. `331bf67` — ambas pruebas E2E ahora ejecutan el RENDER COMPLETO (no
   solo el resolver): avatar (video final real descargable, verificado
   con ffprobe) e imagen generada + stock mezclados en un mismo render
   de Remotion (nueva puerta de solo-pruebas en `storyboard/simulate.ts`,
   `STORYBOARD_SIMULATE_FORCE_GENERATED_IMAGE_SCENE_INDEX`).

**Verificación repetida antes de cada commit**: `tsc --noEmit` limpio,
`eslint` limpio, `npm run test:unit` completo 442/442 sin regresiones,
más ejecución real de ambos scripts E2E con evidencia inspeccionada por
`ffprobe` (ver sección 5).

**Instrucción pendiente del usuario, aún no resuelta**: la prueba REAL
de avatar (pagada, D-ID) debe hacerse con una fotografía del propio
usuario — **nunca** una persona de stock ni un rostro generado como
sustituto. Esa foto NO debe incluirse en el repositorio ni en artifacts
públicos de CI. Falta: (a) publicar los requisitos exactos de la foto
(ver sección 7b) y el mecanismo de subida privada, y (b) el propio
usuario debe autorizar el costo antes de ejecutar nada pagado — no se
ha contratado ni ejecutado ninguna llamada real.

**Lo que queda pendiente de esta fase (sin empezar o parcial)**:
- Actualizar `docs/AVATAR_MODE.md` con la corrección `audioUrl`/`voiceId`
  y el texto honesto sobre `DELETE` (el código y este documento ya lo
  reflejan; `AVATAR_MODE.md` todavía describe la primera ronda de
  correcciones, con `voiceId` como obligatorio siempre — desactualizado).
- Publicar los MP4/capturas de esta ronda como GitHub Actions artifacts
  (punto 4 de la fase) — por ahora la evidencia solo existe localmente
  en `/tmp/e2e-evidence/` (avatar y mezcla imagen+stock), no versionada
  ni subida a CI. **Siguiente paso de mayor impacto**: crear o extender
  un workflow de GitHub Actions que corra
  `scripts/test-pipeline-avatar.ts` y `scripts/test-pipeline-visual-mix.ts`
  con `--out-dir` y suba el resultado con `actions/upload-artifact`
  (nunca URLs firmadas ni secretos en los logs).
- Punto 5 (despliegue): sin cambios desde la sección 2 — sigue sin
  poder verificarse por falta de acceso a Vercel.
- Punto 6 (tarifas/requisitos reales de D-ID): sección 7b tiene el
  estimado de costo de una ronda anterior; falta reverificar contra
  fuentes oficiales en esta ronda (bloqueo de red a `d-id.com` sigue
  activo) y preparar el mecanismo de "una sola prueba autorizada, sin
  reintentos automáticos" explícitamente.
- Reporte final breve de esta fase — no entregado todavía en este
  documento (sí como mensaje de chat al usuario).

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

## 2. Rama y despliegue

- **No existe una rama `main`** en `hanzmo16-png/Atomivid`. Las ramas
  remotas son `claude/atomivid-mvp-setup-0079jv` (esta, con todo el
  trabajo de ATOMIVID — es la rama BASE de desarrollo, por instrucción
  explícita, sin afirmar que sea "producción"), `claude/e2e-verification-scripts`
  (rama nueva de este turno, ver punto 3), y dos ramas
  `codex/growth-engine-*` (foundation + dashboard) — **trabajo no
  relacionado a preservar, confirmado por el usuario**, no tocadas.
- La rama DEFAULT del repositorio en GitHub ES
  `claude/atomivid-mvp-setup-0079jv` (confirmado vía `list_commits` sin
  especificar rama).
- **Despliegue: NO VERIFICADO por falta de acceso a Vercel.** Se intentó
  identificarlo vía GitHub (deployments/checks) — no hay herramienta
  expuesta en esta sesión para listar check-runs de apps externas (Vercel)
  ni la API de deployments de GitHub, y no hay `vercel.json` en el repo.
  Registrado como bloqueo de acceso, no como una suposición.

## 3. Cambios nuevos — en rama separada, PR abierto sin fusionar

Por instrucción explícita: a partir de ahora, cambios nuevos van en una
rama separada con PR hacia `claude/atomivid-mvp-setup-0079jv`, nunca
fusionado automáticamente.

- **PR #1** (`claude/e2e-verification-scripts` → `claude/atomivid-mvp-setup-0079jv`):
  https://github.com/hanzmo16-png/Atomivid/pull/1 — **Abierto, sin
  fusionar**, ahora con 5 commits (trazabilidad completa, ver sección 0):
  los 2 scripts E2E originales (`fe0bb46`), la corrección del contrato
  D-ID `audioUrl`/`voiceId` + wording de `DELETE` (`02f6306`, SÍ toca
  código de producción: `src/lib/providers/types.ts`,
  `src/lib/providers/avatar/did.ts`, `src/lib/video/avatar/pipeline.ts`
  — corrige un bug real introducido en `20ec5ae`, no es solo tooling de
  pruebas), el reemplazo del fixture de avatar por un MP4 real
  (`71f57f9`, toca `src/lib/providers/avatar/fixture.ts`), y el cierre
  de la brecha resolver-vs-render-completo (`331bf67`, toca
  `src/lib/video/storyboard/simulate.ts` con una puerta opt-in de solo
  pruebas + 2 scripts). tsc/eslint/442 tests verdes en cada commit.
  Pendiente de tu revisión antes de fusionar.

## 4. Adaptador D-ID — corregido contra documentación oficial (dos rondas)

Acceso directo a `docs.d-id.com`/`www.d-id.com` sigue bloqueado
(`EGRESS_BLOCKED`, confirmado de nuevo este turno) — pero WebSearch
devolvió resultados que citan directamente páginas oficiales.

**Ronda 1** (`20ec5ae`):
1. **Autenticación**: la API key es `usuario:contraseña`, el header debe
   ser `Basic <base64(usuario:contraseña)>` — el código anterior mandaba
   la clave cruda sin codificar. Corregido.
2. **Subida de foto** (`POST /images`): es `multipart/form-data` (campo
   `image`, solo jpeg/png) — el código anterior mandaba JSON. Corregido, y
   ahora se rechaza cualquier otro mimeType antes de gastar la llamada.
3. **Cancelación**: confirmado que `DELETE /talks/{id}` existe
   (`docs.d-id.com/reference/deletetalk`).

**Ronda 2** (`02f6306`, esta fase — corrige dos errores de la ronda 1):
1. **`voiceId` NO siempre es obligatorio** — la ronda 1 lo exigía
   siempre, lo cual no reflejaba el flujo real de ATOMIVID (foto + audio
   YA sintetizado por nuestro propio ElevenLabs, nunca la síntesis
   interna de D-ID). Corregido: `AvatarVideoRequest` gana `audioUrl?`;
   cuando está presente, `generateVideo()` manda
   `script: {type:"audio", audio_url}` (D-ID usa NUESTRO audio, sin
   voiceId); solo cuando NO hay `audioUrl` se exige `voiceId` y se manda
   `script: {type:"text", input, provider:{type:"elevenlabs", voice_id}}`
   (D-ID sintetiza voz él mismo, función de pago aparte). `pipeline.ts`
   ahora sintetiza y aloja la narración propia (ElevenLabs vía
   `getVoiceProvider()`, URL firmada de Supabase Storage de 1h) ANTES de
   llamar al proveedor, así que el flujo real nunca depende de la
   síntesis del proveedor salvo fallo de subida.
2. **`DELETE` NO es cancelación confirmada** — la ronda 1 dejaba
   ambigüedad; `cancelVideo()` ahora declara explícitamente en código y
   mensajes que NO hay evidencia documental de que `DELETE /talks/{id}`
   detenga un render en curso o evite el cargo — nunca se presenta como
   ahorro de costos.
3. **Auth reconfirmada (sin cambio de código)**: la credencial de D-ID
   Account Settings es texto plano `USERNAME:PASSWORD`, se codifica a
   base64 UNA sola vez — no hay riesgo de doble codificación.

Sigue sin confirmar (marcado explícitamente en el código): payload exacto
del webhook, límite de caracteres real, forma exacta del error. Precio:
~$0.0983/s según agregadores de terceros (no D-ID directamente) — **sin
reverificar contra fuente oficial en esta ronda** (punto 6 de la fase
actual, pendiente).

**D-ID y toda generación pagada siguen apagados por defecto**
(`AVATAR_MODE_ENABLED=false`, `AVATAR_PROVIDER=fixture`,
`OPENAI_IMAGE_GENERATION_ENABLED=false`, `PREMIUM_CLIPS_ENABLED=false`).
Los tests con fetch mockeado prueban que el CÓDIGO hace lo esperado —
NUNCA prueban compatibilidad real con la API de D-ID.

## 5. Evidencia de los flujos con fixtures (esta sesión)

| Flujo | Estado | Evidencia |
|---|---|---|
| Video faceless completo | ✅ Real, verificado | `scripts/atomivid-test-output.mp4` — ffprobe confirma H.264 1080×1920 (9:16 correcto) + audio AAC 96kHz, 112s. Frame extraído muestra subtítulos quemados legibles. Enviado como artifact. |
| Imagen generada mezclada con stock | ✅ Real, RENDER COMPLETO (esta fase, `331bf67`) | `scripts/test-pipeline-visual-mix.ts` corre `generateVideoFromScript()` de punta a punta: escena 0 forzada a `generated_image` (puerta de solo-pruebas en `storyboard/simulate.ts`, ver sección 0) resuelta por el proveedor fixture ($0, log `[atomivid:visual] status:"generated"`), resto de escenas por stock. Video final real verificado con ffprobe: H.264 1080×1920 (9:16), AAC, 69.7s. Evidencia local en `/tmp/e2e-evidence/visual-mix/` (no versionada — pendiente de subir como artifact de CI, ver sección 0). Antes de esta fase solo se había verificado el resolver aislado (`dry-run-visual-mix.ts`), no el render — brecha ya cerrada. |
| Avatar: foto de prueba → video final | ✅ Real, RENDER COMPLETO (esta fase, `71f57f9` + `331bf67`) | `scripts/test-pipeline-avatar.ts --out-dir` ejecutado con una foto JPEG real (800×800, `validatePhotoBuffer` OK): confirmó consentimiento obligatorio, aislamiento entre usuarios (`avatar_not_owned`), costo $0, idempotencia. El fixture de avatar ahora devuelve un MP4 real y válido (h264 720×1280, aac, "VIDEO SIMULADO" incrustado en los fotogramas — sin ningún rostro real ni de stock) en vez de bytes de texto — el video final se escribió a disco y ffprobe confirmó: h264 720×1280 (9:16), AAC presente, 6s. Narración propia (ElevenLabs vía fixture) también verificada subida ANTES del proveedor (226KB WAV real). **Sigue sin resolver** (no es un bug, es una limitación de diseño ya documentada): el modo avatar no superpone subtítulos propios — el proveedor ya devuelve audio+labios sincronizados sin marcas de tiempo por palabra. Esta prueba NO valida calidad ni lip-sync de un proveedor real — el video de origen es un patrón sintético. |
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
- **Instrucción explícita del usuario (esta fase)**: la prueba real debe
  hacerse con una fotografía DEL PROPIO USUARIO — nunca una persona de
  stock ni un rostro generado como sustituto. Esa foto no debe subirse
  al repositorio ni a artifacts públicos de CI; el mecanismo de subida
  privada (vía el flujo ya existente de `/dashboard` → avatar, Supabase
  Storage privado + RLS, ver sección 5) y los requisitos exactos de la
  foto (formato, resolución mínima, consentimiento) se documentarán como
  siguiente paso antes de pedir la foto — ver sección 0.
- Requiere: `DID_API_KEY` real (no configurada), y confirmar el plan
  contratado incluye ElevenLabs como proveedor de voz (documentado como
  función de pago en D-ID).
- Con `audioUrl` (flujo real de ATOMIVID, esta fase): NO se necesita que
  D-ID sintetice voz — el costo de ElevenLabs (nuestro, ya integrado)
  se suma aparte al de D-ID, y `voiceId`/función de voz de D-ID NO
  aplica a esta prueba salvo que se decida probar también el flujo de
  texto-a-voz interno de D-ID (serían dos pruebas distintas).
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
en esta sesión ni en la fase actual (2026-09-18). Todo lo generado
(guion, voz, imágenes, video de avatar, video final mezclado) vino de
proveedores `fixture`, incluyendo el nuevo MP4 simulado del avatar
(generado localmente con ffmpeg, sin llamar a ningún servicio externo).
La única red externa real usada: `ip-ranges.amazonaws.com` (dato
público, sin autenticación, sin costo) y WebSearch para investigación de
documentación D-ID (sin costo para ATOMIVID).


## 2026-09-18 — reserva duradera de generación de avatar

Rama `codex/avatar-single-attempt`, basada en `94de6f0` (la corrección anterior
ya estaba publicada con SHA distinto de la copia local `ecbf950`, contenido idéntico).
Nueva migración 0014 pendiente de aplicar: columna `avatar_generation_started_at`.
Compare-and-set por request y propietario antes de voz, excluyendo jobs existentes.
La reserva no se libera automáticamente ni por fallos de narración. Los POST de
video D-ID/HeyGen no se reintentan; job persistido antes de polling mediante callback.
Ver docs/AVATAR_REAL_TEST.md para autorización, límites y bloqueos de ejecución.
Foto privada no incorporada al repositorio. Sin consumo pagado en esta sesión.
