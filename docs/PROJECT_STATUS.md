# Estado del proyecto — ATOMIVID

> Documento de continuidad permanente. Objetivo: que una sesión nueva (Claude
> u otra persona) pueda retomar el proyecto mañana leyendo solo esto, sin
> depender del historial de conversación de ninguna sesión anterior.
>
> Convención de este documento: cada afirmación está marcada implícitamente
> por su sección — "Completado y probado en producción real" y "Verificado"
> son hechos comprobados; "Estimación"/"sin verificar" son suposiciones o
> trabajo no confirmado; "Pendiente" es trabajo no iniciado o no terminado.
> Ninguna sección de este documento declara producción lista para usuarios
> reales de pago sin decirlo explícitamente.

## 1. Nombre y objetivo del producto

**ATOMIVID** — SaaS que convierte una idea/tema de texto en un video
vertical (9:16) listo para publicar: guion generado por IA, narración de
voz, clips/imágenes de fondo, música y subtítulos, todo automático, sin
cámara ni edición manual. Suscripción mensual de pago (Stripe) con cuota de
generaciones.

## 2. Arquitectura y servicios utilizados

- **Frontend + backend**: Next.js 16 (App Router, TypeScript, React 19),
  Tailwind CSS v4 (`@theme inline`).
- **Auth + base de datos + storage**: Supabase (Postgres, Auth, Storage;
  RLS activo en todas las tablas de usuario).
- **Pagos**: Stripe — suscripción mensual, modo **prueba** únicamente (ver
  sección 11).
- **Generación de guion**: Claude API (Anthropic SDK).
- **Voz**: ElevenLabs (ver configuración aprobada en sección 7).
- **Footage/imágenes**: Pexels (video primero, fotografía + Ken Burns como
  respaldo).
- **Música de fondo**: banco curado manualmente (`MUSIC_MANIFEST`, 2 pistas
  reales hoy), servido desde un bucket privado de Supabase Storage
  (`music-library`) con URL firmada de máximo 1 hora generada solo en
  servidor — nunca una URL pública ni permanente.
- **Motor de composición/render**: Remotion (usa FFmpeg internamente).
- **Worker en background**: GitHub Actions (`scripts/render-worker.ts` +
  workflow dedicado) — elegido sobre Railway/Render.com/Remotion Lambda por
  costo $0 dentro de cuota gratuita y cero reescritura del pipeline. Ver
  `DECISIONS.md` para el análisis completo y por qué Remotion Lambda queda
  documentado como el siguiente paso para escalar (requiere cuenta AWS, no
  contratada).
- **Patrón de adaptadores** (`src/lib/providers/`): cada etapa externa
  (guion/voz/footage/música) tiene implementación "real" y "fixture"
  (determinística, sin red), con auto-selección por variable de entorno.
  Esto es lo que permite probar el pipeline completo sin gastar ni depender
  de red externa.
- **Despliegue**: Vercel (proyecto ya configurado por el usuario fuera de
  este repo; este entorno de Claude Code no tiene salida de red hacia
  Vercel — no se puede desplegar ni verificar visualmente desde aquí sin
  pasar por GitHub).

Documento de decisiones técnicas detalladas (el "por qué" de cada elección
de arquitectura): **`DECISIONS.md`** en la raíz del repo — léase junto con
este archivo, no se duplica su contenido aquí.

## 3. Rama activa

`claude/atomivid-mvp-setup-0079jv`

Convención de todo el trabajo reciente: desarrollar y publicar en esta
rama, nunca hacer force push, nunca mezclar a producción sin autorización
explícita del usuario.

## 4. Commit inicial de esta fase y HEAD final

- **Commit inicial de la Fase 2** ("preparación de la beta", punto de
  partida acordado con el usuario): `c691eb6ce04582a7b91308e5e632216522e24ab0`
  (`docs(decisions): registra el rediseño de beta pública y su alcance`).
- **HEAD al momento de escribir este documento**:
  `f31f880863fed3e3e9f6e6340a3ac94b3956454e`
  (`test(dev): estados visuales simulados para QA sin Supabase`).
- Este mismo documento se publica en un commit posterior a ese HEAD (ver
  sección 17 para el enlace exacto una vez publicado).

## 5. Lista cronológica de commits relevantes publicados (Fase 2)

1. `c691eb6` — `docs(decisions): registra el rediseño de beta pública y su alcance`
   (fin de la Fase 1 / punto de partida de la Fase 2).
2. `796b837` — `feat(dashboard): pantalla dedicada de resultado por solicitud`
   (`/dashboard/videos/[id]`, `RequestCard`/`ResultView` extraídos, fix de
   layout `min-w-0` en `<body>`, fix de truncado del título de tarjeta).
3. `68f8e75` — `feat(onboarding): guía inicial de 5 pasos, omitible y reabrible`.
4. `f31f880` — `test(dev): estados visuales simulados para QA sin Supabase`
   (`/dev/states`, inexistente fuera de `next dev`).

(Para el historial completo previo a `c691eb6` — sistema visual, landing,
autenticación, dashboard, SEO — ver `git log` en la rama; no se repite aquí
para no duplicar información que ya vive en los mensajes de commit.)

## 6. Estado actual del pipeline

**Sin cambios en esta fase** — la instrucción explícita del usuario fue no
tocar el pipeline audiovisual, y así se cumplió. Estado heredado de la Fase
1 (ver README.md, sección "Completado / pendiente", y `DECISIONS.md`):

- Guion (Claude) → Voz (ElevenLabs) → Escenas alineadas a narración →
  Footage por escena (Pexels) → Música de fondo (banco curado) →
  Subtítulos por frase → Render (Remotion) → Storage (privado, URL
  firmada) → Historial.
- Verificado end-to-end en producción real (Supabase real, ElevenLabs
  real, Pexels real, Claude real, GitHub Actions real) mediante
  `workflow_dispatch` manual sobre una solicitud sembrada directamente en
  la base de datos — **no** mediante un clic real en la UI de Vercel (ver
  sección 8 para el detalle exacto).
- Límites de entrada (duración/longitud de tema/estilo/escenas) validados
  en servidor y con `CHECK` constraints en base de datos, no solo en UI.

## 7. Configuración aprobada de voz (no modificar sin autorización)

- **Voz**: Mateo.
- **`voice_id`**: `uYlzyj2kIZo3HfBB21vF`.
- **Modelo**: `eleven_multilingual_v2`.
- **`voice_settings` aprobados** (`src/lib/ai/voice.ts`):
  - `stability: 0.45`
  - `similarity_boost: 0.75`
  - `style: 0.2`
  - `use_speaker_boost: true`
- Ambos (`voice_id` y `model_id`) son overrideables por variable de entorno
  (`ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`) pero **el valor por
  defecto en código es el aprobado** — no cambiar el default sin
  autorización explícita del usuario.
- También existe soporte opcional de voz específica por idioma
  (`ELEVENLABS_VOICE_ID_ES`/`_EN`) — no configurado por defecto; la voz
  multilingüe única (Mateo) ya cubre ambos idiomas.

## 8. Resultado de la última generación E2E

**Verificado en producción real** (créditos/cuenta reales del usuario, no
fixtures): worker de render completo disparado manualmente
(`workflow_dispatch` de GitHub Actions) sobre una solicitud sembrada
directamente en la base de datos real de Supabase —

- Voz real (ElevenLabs), footage real (Pexels), **música fixture** (el
  render verificado se hizo *antes* de que `MUSIC_MANIFEST` tuviera pistas
  reales cargadas — ver "Pendiente" más abajo), render con
  Remotion/Chromium, subida a Supabase Storage.
- Video final verificado con `ffprobe` dentro del runner: H.264,
  1080×1920, 30 fps, audio AAC, ~14 MB.
- Incluye guarda de idempotencia/concurrencia, límite de 3 reintentos,
  timeout de 15 min con aviso/reintento visible en el historial, y "marcar
  como fallido" si el workflow muere — confirmado en la práctica (se
  activó correctamente durante los primeros intentos mientras se
  ajustaban credenciales).
- Generación de guion real con Claude y regeneración de escena: probadas
  por separado con `scripts/test-real-script.ts` — guion coherente y en
  tema.

**No verificado todavía** (ver sección 15, prioridad alta):
- El disparo **automático** real desde un clic en la UI de Vercel
  (`/dashboard/review/[id]` → "Generar video final" → `repository_dispatch`)
  — investigado y confirmado que no se puede probar desde este entorno de
  Claude Code bajo ningún token disponible (sin salida de red hacia
  Vercel). Requiere que el usuario lo pruebe manualmente en la app
  desplegada.
- Una generación real usando las pistas reales ya cargadas en
  `MUSIC_MANIFEST`/bucket `music-library` — el render con `ffprobe` de
  arriba se hizo con música fixture, no con las pistas reales.
- Cualquier transacción real de Stripe.

## 9. Estado del diseño, landing, autenticación, dashboard, onboarding y resultado dedicado

- **Sistema de diseño**: tokens propios vía `@theme inline` (Tailwind v4),
  oscuro, un solo acento violeta controlado — reemplazó el Tailwind gris
  genérico de `create-next-app`. Sin librería de componentes nueva.
- **Landing** (`src/app/page.tsx`): hero, flujo en 6 pasos, beneficios,
  casos de uso, calidad, FAQ, footer. Sin métricas ni testimonios
  inventados, sin sección de precios (no hay un precio de Stripe
  verificable desde este entorno). QA visual (Playwright, 390×844 y
  1440×900) sin overflow ni truncados — ver capturas entregadas en la
  conversación de la Fase 2.
- **Autenticación** (login/register): funcional sobre la lógica ya
  validada; mensajes de error humanizados (`humanizeAuthError`, 11
  pruebas); `redirectedFrom` respetado tras login con protección contra
  open redirect (`safeRedirectTarget`).
- **Dashboard**: historial con tarjetas (`RequestCard`, extraído esta
  fase) que muestran estado real (pendiente/procesando/completado/error),
  reproducción y descarga inline, y enlace "Ver detalles" a la pantalla
  dedicada. Layout corregido esta fase para apilarse en columna en móvil
  en vez de comprimirse en dos columnas angostas.
- **Onboarding** (nuevo esta fase): 5 pasos breves y omitibles en
  cualquier momento, nunca bloquea el dashboard, recordado en
  `localStorage` (sin datos sensibles), reabrible desde un botón de ayuda
  flotante. Diálogo accesible (`role="dialog"`, `aria-modal`, trampa de
  foco, `Escape` cierra, foco restaurado al elemento que lo abrió),
  respeta `prefers-reduced-motion`. Sin migraciones. Probado con
  Playwright (apertura en primera visita, navegación por teclado, cierre,
  reapertura) en ambos viewports.
- **Resultado dedicado** (`/dashboard/videos/[id]`, nuevo esta fase):
  verifica sesión, filtra por `user_id` en la consulta **y** revalida
  propiedad en código (`selectIfOwned`, con test explícito de acceso
  cruzado entre usuarios) antes de mostrar nada; `notFound()` para
  solicitudes ajenas o inexistentes. Reutiliza el mecanismo de URL firmada
  existente; nunca expone rutas de Storage, proveedor ni costos internos;
  no inventa porcentajes de progreso. Los 5 estados reales (pendiente,
  procesando, completado, error, completado sin URL firmada) están
  cubiertos.

Nota: ningún cambio de esta fase tocó lógica de datos, RLS, Supabase
remoto, Stripe ni el pipeline — instrucción explícita del usuario,
cumplida y verificable en el diff de los 3 commits de la sección 5.

## 10. Estado de Supabase y migraciones

- **Sin cambios en esta fase** — no se aplicó ninguna migración nueva, no
  se modificó RLS, no se tocaron datos remotos.
- Estado heredado (verificado, según README.md/`DECISIONS.md`): 9
  migraciones aplicadas y confirmadas en el proyecto real de Supabase
  (`0001` a `0009`). `0008` (`language_exists`, `generation_costs_exists`)
  y `0009` (columnas `music_track_*`/`music_fallback_reason`) confirmadas
  explícitamente por el usuario tras aplicarlas.
- Bucket `videos` privado con URLs firmadas (no público) — confirmado con
  descarga real de un video de prueba.
- Bucket `music-library` privado (creado por el usuario, sin policies
  públicas) con URL firmada bajo demanda (máx. 1 hora), solo en servidor.
- **Pendiente conocido, sin resolver**: queda una solicitud/usuario de
  prueba en la base de datos real (tema `"[PRUEBA AUTOMÁTICA] Validación
  técnica del worker de Atomivid"`, usuario con email bajo
  `atomivid-internal.test`) — borrar cuando ya no se necesite como
  referencia (requiere decisión/acción del usuario, no de esta sesión).

## 11. Estado de Stripe y lo que todavía no se ha verificado

- **Modo**: prueba (test) únicamente. Nunca se ha tocado Stripe Live desde
  ninguna sesión de Claude Code.
- **Completado y probado localmente (fixtures/código, no transacción
  real)**: checkout, portal de facturación, webhook con verificación de
  firma (`checkout.session.completed`, `customer.subscription.*`), upsert
  idempotente por `user_id`, cuota mensual que restringe la generación.
- **Auditoría de código** (Fase 1): confirmada correcta por lectura directa
  del código — verificación de firma del webhook presente, manejo de
  eventos correcto.
- **No verificado, explícitamente pendiente**:
  - Ninguna transacción real de Stripe (checkout → webhook → estado de
    suscripción reflejado en la app) — no probado nunca.
  - El producto/precio real configurado en el dashboard de Stripe — no se
    pudo confirmar porque este entorno no tiene `STRIPE_SECRET_KEY` ni
    salida de red hacia Stripe.
  - El estado real del modo prueba en la cuenta de Stripe del usuario.
- **No declarar Stripe listo para producción** hasta que se verifique al
  menos una transacción real de extremo a extremo.

## 12. Pruebas ejecutadas y resultados (Fase 2, este HEAD)

Todas ejecutadas localmente en este entorno, contra el HEAD
`f31f880863fed3e3e9f6e6340a3ac94b3956454e`:

- `npx tsc --noEmit`: **sin errores**.
- `npm run lint` (ESLint, incluye reglas de React Compiler
  `react-hooks/purity` y `react-hooks/set-state-in-effect`): **sin errores
  ni warnings**.
- `npm run test:unit`: **91/91 pruebas pasando** (10 nuevas esta fase: 4 de
  `src/lib/video/access.test.ts` — incluye el test explícito de que un
  usuario no puede acceder a una solicitud ajena por ID — y 6 de
  `src/lib/onboarding/steps.test.ts`).
- `npm run build`: **exitoso**. `/dev/states` confirmado como 404 real
  (no solo oculto) sirviendo un build de producción localmente
  (`NODE_ENV=production`, igual que un preview de Vercel); `/privacy`
  respondió 200 en el mismo build, de control.
- QA visual manual con Playwright + Chromium local: landing, login,
  register, privacy, terms, dashboard vacío/pendiente/procesando/
  completado/error (vía fixtures `/dev/states`), resultado dedicado
  (completado/procesando/error), onboarding — en 390×844 y 1440×900. Se
  encontraron y corrigieron 3 problemas reales de layout en móvil (ver
  commit `796b837`: `min-w-0` faltante en `<body>`, truncado roto en el
  título de tarjeta, columnas apretadas en la tarjeta de historial).
  `prefers-reduced-motion` confirmado correcto (spinner y pulso sin
  animación).
- Escaneo de secretos sobre el diff completo antes de cada commit: sin
  coincidencias (dos patrones: `key=value` tipo credencial, y formatos
  conocidos como `sk-`/`AKIA`/JWT/`ghp_`).
- **No ejecutado en esta fase**: ninguna prueba contra Supabase remoto real
  ni generación real (instrucción explícita del usuario) — todo lo de
  arriba corrió con fixtures o sin red externa, excepto el análisis de
  configuración de voz (sección 7), que es lectura de código, no una
  llamada real.

## 13. Decisiones que no deben revertirse sin autorización explícita

- La voz Mateo (`uYlzyj2kIZo3HfBB21vF`) y sus `voice_settings` aprobados
  (sección 7) — no cambiar el valor por defecto en código.
- El modelo `eleven_multilingual_v2`.
- El pipeline completo guion→voz→footage→música→subtítulos→render tal
  como está (ver `DECISIONS.md` para cada decisión individual y su razón:
  patrón de adaptadores, dos fases guion/render, worker en GitHub Actions,
  bucket privado + URL firmada, límites de entrada server-side, banco de
  música curado manualmente, mezcla dentro de Remotion sin FFmpeg externo).
- RLS activo en todas las tablas de usuario — nunca debilitarlo.
- Las 9 migraciones aplicadas (`0001`–`0009`) — no reaplicar ni revertir
  sin coordinar con el estado real de la base de datos remota.
- Stripe en modo prueba — nunca tocar Stripe Live sin autorización
  explícita y nueva del usuario.
- El gate `NODE_ENV === "production"` de `/dev/states` — es lo que
  garantiza que los fixtures nunca se sirvan en producción ni en preview;
  no reemplazar por una variable de entorno separada sin verificar de
  nuevo que también cubre los previews de Vercel.

## 14. Limitaciones y restricciones de seguridad

- Este entorno de Claude Code no tiene salida de red hacia Vercel,
  Supabase, ElevenLabs, Pexels, Stripe ni el almacenamiento de artifacts
  de GitHub Actions — solo hacia `api.anthropic.com`, registros de
  paquetes, y la API de GitHub vía el conector MCP de esta sesión. Por eso
  ninguna verificación de esta fase (ni de la anterior) pudo hacerse
  "probando la app en vivo" — se hizo por lectura de código, tests locales
  con fixtures, o disparando workflows de GitHub Actions y leyendo sus
  logs.
- Ninguna sesión de Claude Code debe: ejecutar generaciones reales que
  consuman créditos, tocar Stripe Live, aplicar migraciones sin
  autorización, modificar datos remotos, cambiar secretos/variables de
  entorno, debilitar RLS, activar mocks/fixtures en producción, hacer
  cargos reales, desplegar manualmente a producción, hacer force push, o
  agregar dependencias grandes sin necesidad clara.
- `/dev/states` (fixtures visuales) nunca debe mezclarse con datos reales
  ni activarse por un parámetro público — el único gate es
  `NODE_ENV === "production"` en tiempo de build.
- No hay ninguna API key, token, contraseña ni secreto en este documento
  ni en ningún archivo `.env*` versionado (están en `.gitignore`).

## 15. Pendientes, ordenados por prioridad

1. **Alta** — Obtener y revisar el preview de Vercel del Draft PR de esta
   fase (ver sección 16 y 17).
2. **Alta** — Evaluación visual humana de landing y logotipo sobre ese
   preview (no se puede hacer desde este entorno sin salida de red hacia
   Vercel).
3. **Media** — Probar el disparo automático real del render desde un clic
   en la UI desplegada (`/dashboard/review/[id]` → "Generar video final")
   — nunca probado, solo el `workflow_dispatch` manual.
4. **Media** — Probar una generación real usando las pistas ya cargadas en
   `MUSIC_MANIFEST`/`music-library` (el único render E2E verificado usó
   música fixture).
5. **Media** — Ampliar `MUSIC_MANIFEST` de 2 a ~10-15 pistas para variedad
   completa entre estilos (bucket ya existe).
6. **Media** — Probar al menos una transacción real de Stripe
   (checkout → webhook → estado de suscripción reflejado en la app).
7. **Baja** — Definir un campo estructurado de atribución adicional en
   `MusicTrackEntry` (p. ej. `suggestedCredit?: string`) si se necesita
   mostrar créditos tipo "Music by X from Pixabay" en algún lugar visible.
8. **Baja** — Decidir si escalar a Remotion Lambda cuando haya usuarios de
   pago (requiere cuenta AWS, no contratada).
9. **Baja** — Borrar la solicitud/usuario de prueba interno que quedó en
   la base de datos real (ver sección 10).
10. **Sin fecha / decisión del usuario** — Cancelar un render en curso y
    un cron/reaper activo para renders colgados: evaluados y descartados a
    propósito en el MVP (ver `DECISIONS.md`, "Qué se dejó fuera del MVP a
    propósito") — revisar solo si el volumen de usuarios lo justifica.

## 16. Siguiente paso exacto

1. Obtener y revisar el preview de Vercel generado a partir del Draft PR
   de esta fase (no crear el preview manualmente, no desplegar a
   producción).
2. Evaluar visualmente landing y logotipo sobre ese preview.
3. Recién después de esa evaluación, iniciar la fase de identidad visual
   (si el usuario la confirma).
4. **No hacer merge todavía** — el Draft PR permanece abierto como borrador
   hasta que el usuario decida lo contrario.

## 17. Enlaces relevantes

- **Repositorio**: https://github.com/hanzmo16-png/Atomivid
- **Rama**: `claude/atomivid-mvp-setup-0079jv` —
  https://github.com/hanzmo16-png/Atomivid/tree/claude/atomivid-mvp-setup-0079jv
- **Commits de la Fase 2**:
  - https://github.com/hanzmo16-png/Atomivid/commit/c691eb6ce04582a7b91308e5e632216522e24ab0
  - https://github.com/hanzmo16-png/Atomivid/commit/796b837
  - https://github.com/hanzmo16-png/Atomivid/commit/68f8e75
  - https://github.com/hanzmo16-png/Atomivid/commit/f31f880863fed3e3e9f6e6340a3ac94b3956454e
- **Draft PR**: _pendiente de crear — se agrega el enlace aquí en cuanto
  exista (ver secuencia de esta tarea)._
- **Preview de Vercel**: _pendiente de confirmar — se agrega aquí solo si
  se puede verificar (ver sección 15, pendiente #1). Si no se puede
  verificar desde este entorno, se documenta el bloqueador exacto en su
  lugar, no una URL adivinada._

## 18. Fecha y hora de actualización

2026-09-16T06:11:41Z (UTC) — versión inicial de este documento, HEAD
`f31f880863fed3e3e9f6e6340a3ac94b3956454e`.
