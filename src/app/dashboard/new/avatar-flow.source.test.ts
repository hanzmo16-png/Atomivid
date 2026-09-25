import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regresión estructural del RC mission Avatar (2026-09-25) — actions.ts
 * hace demasiada I/O real (Storage, providers, Supabase) para probarse
 * directamente sin un runtime de Server Actions completo (mismo motivo
 * por el que este archivo no tenía tests antes). Se fijan aquí, por
 * contenido de la fuente, los dos bugs reales encontrados y corregidos:
 *
 * 1. "Grabar mi voz"/"Subir audio" estaban bloqueados para HeyGen (el
 *    proveedor default real, AVATAR_PROVIDER=heygen) por una restricción
 *    `!["did","fixture"].includes(...)` que ya no reflejaba que
 *    avatar/pipeline.ts SÍ soporta recordedAudioPath con HeyGen (ver
 *    pipeline.test.ts: "HeyGen recorded pipeline preserves owner
 *    association...").
 * 2. El límite combinado "foto+audio <= 3 MB" (MAX_AVATAR_FORM_BYTES)
 *    rechazaba una grabación real de ~45s — reemplazado por límites
 *    independientes (recording.test.ts).
 */
const ACTIONS_PATH = path.join(__dirname, "actions.ts");
const CONTENT_TYPE_STEP_PATH = path.join(__dirname, "ContentTypeStep.tsx");
const NEW_VIDEO_FORM_PATH = path.join(__dirname, "NewVideoForm.tsx");
const REVIEW_PAGE_PATH = path.join(__dirname, "..", "review", "[id]", "page.tsx");

test("createVideoRequest ya NO restringe narrationSource=recording a solo did/fixture", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.ok(
    !source.includes('!["did", "fixture"].includes(flags.avatarProvider)'),
    "la restricción vieja que bloqueaba grabar/subir audio para HeyGen no debe seguir en el código",
  );
});

test("createVideoRequest ya NO usa un límite combinado foto+audio (MAX_AVATAR_FORM_BYTES)", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.ok(!source.includes("MAX_AVATAR_FORM_BYTES"), "el límite combinado legacy no debe seguir importado/usado");
  assert.ok(source.includes("MAX_AVATAR_PHOTO_BYTES"), "debe validar la foto con su propio límite independiente");
  assert.ok(source.includes("MAX_RECORDING_BYTES"), "debe validar el audio con su propio límite independiente");
});

test("createVideoRequest acepta narrationSource=tts_text (Voz IA desde texto) y reutiliza getVoiceProvider (ElevenLabs)", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.match(source, /"tts_text"/);
  assert.match(source, /getVoiceProvider\(\)\.synthesize\(/, "debe reutilizar el provider de voz existente, no uno paralelo");
  assert.match(source, /recordAvatarNarrationTts\(/, "debe registrar el costo real de la síntesis TTS");
});

test('ContentTypeStep ya NO enlaza "Video con avatar" a la ruta legacy D-ID (/dashboard/avatar/prepare)', () => {
  const source = fs.readFileSync(CONTENT_TYPE_STEP_PATH, "utf-8");
  // Se permite mencionar la ruta legacy en un comentario explicativo (por
  // qué se quitó) — lo que nunca debe existir es un href real hacia ella.
  assert.ok(
    !source.includes('href="/dashboard/avatar/prepare"') && !source.includes("'/dashboard/avatar/prepare'"),
    'ningún usuario debe llegar a la prueba privada D-ID ("no genera video ni consume créditos D-ID", "autorización manual") desde el selector normal',
  );
  assert.match(source, /initialMode=\{mode === "avatar" \? "avatar" : "visual"\}/, "Avatar debe revelar el mismo NewVideoForm preseleccionando su modo interno, igual que Reel");
});

/**
 * Regresión del QA blocker real (2026-09-25): tras el commit anterior, la
 * tarjeta "Video con avatar" desapareció ENTERA del selector en Production
 * para la cuenta beta. Causa real: page.tsx pasaba
 * `avatarAccess={flags.avatarModeEnabled && privateAvatarAccess}` — con
 * AVATAR_MODE_ENABLED apagado en producción (su default), esa expresión es
 * siempre false sin importar el acceso privado. La prueba D-ID legacy NUNCA
 * dependió de ese flag global (por eso Hans sí la veía antes) — la cuenta
 * beta debe seguir viendo y pudiendo usar el modo avatar aunque
 * AVATAR_MODE_ENABLED siga apagado, ahora apuntando al flujo HeyGen nuevo
 * en vez de a D-ID.
 */
const PAGE_PATH = path.join(__dirname, "page.tsx");

test('page.tsx: la tarjeta "Video con avatar" depende SOLO de privateAvatarAccess, no del flag global AVATAR_MODE_ENABLED', () => {
  const source = fs.readFileSync(PAGE_PATH, "utf-8");
  assert.ok(
    !/avatarAccess=\{flags\.avatarModeEnabled\s*&&\s*privateAvatarAccess\}/.test(source),
    "avatarAccess NUNCA debe volver a requerir el flag global además del acceso privado — eso fue exactamente el blocker real",
  );
  assert.match(source, /avatarAccess=\{privateAvatarAccess\}/, "avatarAccess debe depender únicamente de la cuenta beta, igual que la prueba D-ID legacy que sí funcionaba");
});

test("page.tsx: la cuenta beta activa el toggle interno de NewVideoForm aunque AVATAR_MODE_ENABLED (rollout global) esté apagado", () => {
  const source = fs.readFileSync(PAGE_PATH, "utf-8");
  assert.match(
    source,
    /avatarModeUiEnabled\s*=\s*flags\.avatarModeEnabled\s*\|\|\s*privateAvatarAccess/,
    "debe existir una señal efectiva que habilite el modo avatar para la cuenta beta SIN depender de que el flag global esté encendido",
  );
  assert.match(source, /avatarModeEnabled=\{avatarModeUiEnabled\}/, "ese valor efectivo debe ser el que llega a ContentTypeStep/NewVideoForm");
});

test("actions.ts: createVideoRequest acepta mode=avatar para la cuenta beta aunque AVATAR_MODE_ENABLED esté apagado", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.match(
    source,
    /avatarModeUiEnabled\s*=\s*flags\.avatarModeEnabled\s*\|\|\s*canPrepareAvatar\(user\)/,
    "resolveMode ya no debe recibir SOLO flags.avatarModeEnabled — debe aceptar también la cuenta beta privada",
  );
  assert.match(source, /resolveMode\(rawMode,\s*avatarModeUiEnabled\)/);
  // El check de acceso privado (línea previa a esto) debe seguir existiendo
  // como segunda barrera — para que, si el flag global se enciende para
  // todos algún día, una cuenta SIN acceso privado siga sin poder usar
  // mode=avatar.
  assert.match(source, /mode === "avatar" && !canPrepareAvatar\(user\)/);
});

/**
 * Regresión del QA blocker real (2026-09-25, "AVATAR BLOCKER FINAL"):
 * "Revisar grabación" bloqueaba con un mensaje de autorización manual
 * heredado de la prueba privada P2/D-ID — ver render-route-cas.test.ts
 * para las pruebas del gate en sí (render/route.ts). Aquí se fija que
 * ninguna de las dos rutas reales que TAMBIÉN podrían reintroducir ese
 * paradigma (actions.ts al crear la solicitud, page.tsx del selector) lo
 * hagan tampoco.
 */
test("actions.ts nunca vuelve a exigir una autorización/revisión manual por generación para crear la solicitud de avatar", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.ok(
    !source.includes("autorizar la prueba") && !source.includes("intento autorizado"),
    "no debe reaparecer lenguaje de autorización manual (paradigma de prueba privada) en la creación de la solicitud",
  );
});

/**
 * Contrato de duración (RC QA 2026-09-25, Blocker #2 y #3): la duración
 * real del audio ("recording"/"tts_text") se mide en el servidor con
 * measureNarrationSeconds (ffprobe) — el mismo mecanismo ya probado en
 * producción por preparation.ts (prueba privada D-ID) — y se guarda en
 * duration_seconds, en vez del valor del selector 30/60/90 (que para esas
 * dos fuentes ni siquiera se muestra, ver NewVideoForm.tsx).
 */
test("createVideoRequest mide la duración real del audio (measureNarrationSeconds) para recording/tts_text y la usa como duration_seconds", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.match(source, /import\s*\{\s*measureNarrationSeconds\s*\}\s*from\s*"@\/lib\/video\/avatar\/measure-narration"/);
  assert.match(source, /measureNarrationSeconds\(recording\.audioBuffer\)/, "debe medir la grabación/audio subido");
  assert.match(source, /measureNarrationSeconds\(voiceResult\.audioBuffer\)/, "debe medir el audio TTS-desde-texto real, no estimarlo");
  assert.match(
    source,
    /duration_seconds:\s*measuredDurationSeconds !== undefined \? Math\.ceil\(measuredDurationSeconds\) : durationSeconds/,
    "duration_seconds debe usar la duración REAL medida cuando existe, y solo caer al selector 30\\/60\\/90 si la medición no está disponible (guion generado, o fallo de medición puramente informativo)",
  );
});

test('NewVideoForm.tsx oculta el selector 30/60/90 para "Grabar/subir mi voz" y "Voz IA desde texto" (avatarDurationSelectorApplies)', () => {
  const source = fs.readFileSync(NEW_VIDEO_FORM_PATH, "utf-8");
  assert.match(
    source,
    /import\s*\{\s*avatarDurationSelectorApplies\s*\}\s*from\s*"\.\/validation"/,
    "debe reutilizar la lógica pura de validation.ts, no una copia inline que pueda desincronizarse",
  );
  assert.match(source, /avatarDurationSelectorApplies\(mode,\s*avatarNarrationSource\)/);
});

test('review/[id]/page.tsx muestra la duración REAL medida (duration_seconds) en vez de confiar en la metadata del <audio> del navegador', () => {
  const source = fs.readFileSync(REVIEW_PAGE_PATH, "utf-8");
  assert.match(
    source,
    /Duración:\s*\$\{data\.duration_seconds\}s/,
    'debe mostrar "Duración: Xs" con el valor real guardado, no un texto vago sin número',
  );
});

/**
 * Regresión del QA blocker real (2026-09-25, "BETA ACCOUNT BLOCKED BY
 * STARTER ENTITLEMENT"): el bypass de entitlement (quota.ts) no tocó
 * actions.ts en absoluto — se fija aquí que el consentimiento explícito
 * sigue siendo obligatorio e incondicional antes de procesar cualquier
 * envío en modo avatar, exactamente igual que antes de este cambio.
 */
test("actions.ts: el consentimiento explícito sigue siendo obligatorio para CUALQUIER envío de avatar, sin excepción para la cuenta beta", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.match(
    source,
    /if \(!isAvatarConsentGiven\(formData\.get\("avatar_consent"\)\)\) \{\s*redirect\(/,
    "el checkbox de consentimiento debe seguir verificándose en el servidor antes de cualquier otro paso del modo avatar",
  );
});

/**
 * Regresión del QA real (2026-09-25, "AVATAR REAL HEYGEN ATTEMPT
 * FAILED"): la solicitud real de Hans reusó un avatar_id creado por el
 * proveedor "did" (una prueba anterior) para una generación con HeyGen —
 * confirmado leyendo la fila real de producción (avatars.provider_avatar_id
 * era una ruta S3 de D-ID). pipeline.ts rechaza ese desajuste, pero recién
 * DESPUÉS de crear la solicitud — el usuario nunca se entera hasta que el
 * render ya falló. Se corrige en dos capas: la lista de "avatares ya
 * creados" solo debe ofrecer los del proveedor real actual, y el servidor
 * debe rechazar explícitamente un desajuste incluso si de algún modo
 * llegara un existing_avatar_id de otro proveedor.
 */
test('page.tsx: la lista de "avatares ya creados" solo incluye los del proveedor real actual (flags.avatarProvider)', () => {
  const source = fs.readFileSync(PAGE_PATH, "utf-8");
  assert.match(
    source,
    /\.eq\("provider",\s*flags\.avatarProvider\)/,
    "el SELECT de avatares reutilizables debe filtrar por proveedor, no solo por status",
  );
});

test("actions.ts: reusar un avatar_id de OTRO proveedor (p. ej. \"did\" heredado) se rechaza explícitamente antes de crear la solicitud", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  assert.match(
    source,
    /\.select\("id, status, provider"\)/,
    "debe leer también el proveedor del avatar reusado, no solo su status",
  );
  assert.match(
    source,
    /if \(avatar\.provider !== flags\.avatarProvider\) \{\s*redirect\(/,
    "un avatar de otro proveedor debe rechazarse explícitamente, con un mensaje claro, en vez de dejar que pipeline.ts falle mucho más tarde",
  );
});
