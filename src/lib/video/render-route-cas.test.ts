import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * evaluateRenderStart (render-guard.test.ts) cubre la primera línea de
 * defensa contra doble render, pero la garantía real contra una carrera
 * (doble clic, dos pestañas abiertas a la vez) es el UPDATE condicional
 * `.eq("status", videoRequest.status)` en render/route.ts: Postgres
 * serializa los UPDATE concurrentes sobre la misma fila, así que si dos
 * requests leen "script_ready" al mismo tiempo, solo una de las dos
 * consigue que el WHERE siga cumpliéndose cuando le toca ejecutarse — la
 * otra actualiza 0 filas y debe tratarse como rechazo, no como éxito. No
 * es simulable con un mock liviano sin reimplementar semántica de
 * Postgres, así que esta prueba es estructural: confirma que el guard
 * sigue en el código fuente, para que no se pierda sin que un test falle.
 *
 * Este archivo vive fuera de app/api/generate/[id]/render/ a propósito:
 * `node --test <ruta>` trata las rutas de archivo pasadas por CLI como
 * patrones glob, y "[id]" se interpreta como una clase de caracteres —
 * un archivo de test colocado dentro de esa carpeta nunca se ejecuta (se
 * reportan 0 tests, sin ningún error visible). fs.readFileSync sí puede
 * leer esa ruta literal sin problema, así que basta con apuntar aquí a la
 * ruta real y dejar el archivo de test en un directorio sin corchetes.
 */
const ROUTE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "app",
  "api",
  "generate",
  "[id]",
  "render",
  "route.ts",
);

test("render/route.ts protege la transición a processing con un UPDATE condicionado al status leído", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  assert.match(
    source,
    /\.update\(\{[\s\S]*?status:\s*"processing"[\s\S]*?\}\)[\s\S]*?\.eq\("id",\s*id\)[\s\S]*?\.eq\("status",\s*videoRequest\.status\)/,
    "el UPDATE a processing debe seguir condicionado a .eq(\"status\", videoRequest.status)",
  );

  assert.match(
    source,
    /if\s*\(!updated \|\| updated\.length === 0\)/,
    "una carrera perdida (0 filas actualizadas) debe seguir tratándose como rechazo, no como éxito",
  );
});

/**
 * Regresión exacta del incidente en producción (Código: 7bd9fef1): las
 * llamadas a Supabase en render/route.ts pueden lanzar una excepción
 * cruda (fallo de red/conexión que postgrest-js no atrapa) además de
 * devolver `{ error }` normalmente. Sin envolver cada etapa, esa
 * excepción caía directo en el catch-all y se clasificaba igual que
 * cualquier otro fallo — imposible de distinguir sin logs del servidor.
 */
test("render/route.ts etiqueta con RenderStageError las tres etapas que pueden lanzar una excepción cruda de Supabase", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  for (const stage of ["fetch_request", "check_subscription", "mark_processing"]) {
    assert.match(
      source,
      new RegExp(`RenderStageError\\("${stage}"`),
      `debe seguir envolviendo la etapa "${stage}" con RenderStageError`,
    );
  }
});

test('render/route.ts nunca pierde el mensaje ya clasificado del worker si la restauración a "failed" también falla', () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  // El bloque catch de worker.trigger() debe envolver su propio intento de
  // marcar la solicitud como "failed" en un try/catch — y en cualquier
  // caso (éxito, error devuelto, o excepción) debe seguir devolviendo el
  // `message` ya calculado por classifyRenderError, nunca uno nuevo.
  const workerCatchIndex = source.indexOf("logRenderError(`POST /render (worker:");
  assert.ok(workerCatchIndex !== -1, "debe seguir existiendo el catch de worker.trigger()");

  const restCatchIndex = source.indexOf(
    "POST /render (restaurar estado a failed, excepción)",
    workerCatchIndex,
  );
  assert.ok(
    restCatchIndex !== -1,
    "el intento de restaurar el estado a failed debe estar envuelto en su propio try/catch",
  );

  const returnIndex = source.indexOf(
    "NextResponse.json({ error: message }, { status: 500 })",
    restCatchIndex,
  );
  assert.ok(
    returnIndex !== -1,
    "debe seguir devolviendo el mensaje ya clasificado del worker, no uno nuevo, incluso si la restauración falla",
  );
});

/**
 * Regresión exacta del incidente en producción (Código cde1d3da): en
 * Vercel, si faltan GH_WORKER_TOKEN/GH_WORKER_REPO, getRenderWorker()
 * lanza MissingEnvVarError en vez de caer a inline (ver
 * src/lib/worker/index.test.ts). Esa excepción solo evita que la
 * solicitud quede bloqueada en "processing" si getRenderWorker() se
 * llama ANTES del UPDATE que la transiciona a ese estado — si el orden
 * se invirtiera algún día, la solicitud quedaría marcada "processing"
 * sin que ningún worker la esté procesando de verdad.
 */
/**
 * Regresión del QA blocker real (2026-09-25): "Revisar grabación" mostraba
 * "La generación de avatar está bloqueada. Primero se requiere revisar el
 * consumo y autorizar la prueba." — un gate heredado de la prueba privada
 * P2/D-ID que exigía autorización manual por generación, incompatible con
 * el contrato self-service (usuario autorizado + foto/audio válidos +
 * consentimiento + cost guard válido → puede generar, sin aprobación
 * administrativa adicional).
 */
test('render/route.ts ya NO bloquea avatar con "El intento autorizado ya fue utilizado" (un solo intento por solicitud)', () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.ok(
    !source.includes("El intento autorizado ya fue utilizado"),
    "el límite de un solo intento (P2/D-ID legacy) no debe seguir en el código — el reintento debe seguir la misma regla genérica que Reel (evaluateRenderStart/MAX_RENDER_ATTEMPTS)",
  );
  assert.ok(
    !/videoRequest\.mode === "avatar" && videoRequest\.render_attempts > 0/.test(source),
    "no debe existir ningún check especial de render_attempts para avatar por fuera de evaluateRenderStart",
  );
});

test('render/route.ts ya NO exige el flag global AVATAR_MODE_ENABLED además del acceso beta ("La generación de avatar está bloqueada... autorizar la prueba")', () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.ok(
    !source.includes("Primero se requiere revisar el consumo y autorizar la prueba"),
    "el mensaje de autorización manual (paradigma de prueba privada) no debe seguir en el código",
  );
  assert.ok(
    !/!getFeatureFlags\(\)\.avatarModeEnabled \|\| !canPrepareAvatar\(user\)/.test(source),
    "el flag global no debe volver a requerirse ADEMÁS del acceso beta — mismo bug que en dashboard/new/actions.ts y page.tsx",
  );
  assert.match(
    source,
    /!\(getFeatureFlags\(\)\.avatarModeEnabled \|\| canPrepareAvatar\(user\)\)/,
    "el acceso a avatar debe depender del flag global O del acceso beta (acceso efectivo), preservando el allowlist",
  );
});

test("render/route.ts llama a getRenderWorker() antes del UPDATE que transiciona a processing", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  const getWorkerIndex = source.indexOf("getRenderWorker()");
  assert.ok(getWorkerIndex !== -1, "debe seguir llamando a getRenderWorker()");

  const markProcessingIndex = source.indexOf('status: "processing"');
  assert.ok(markProcessingIndex !== -1, 'debe seguir existiendo el UPDATE a "processing"');

  assert.ok(
    getWorkerIndex < markProcessingIndex,
    "getRenderWorker() debe llamarse antes de transicionar la solicitud a \"processing\" — " +
      "si faltan las credenciales de GitHub Actions en Vercel, debe detenerse antes de tocar el estado",
  );
});

/**
 * Regresión del QA blocker real (2026-09-25, "BETA ACCOUNT BLOCKED BY
 * STARTER ENTITLEMENT"): el bypass de entitlement (assertCanGenerate,
 * quota.ts) debe ser imposible de activar desde el cliente — se prueba
 * aquí que el `user` que se le pasa es SIEMPRE el que devuelve
 * supabase.auth.getUser() en este mismo request (identidad verificada
 * server-side por el JWT de la sesión), nunca un valor leído de la
 * request (body/query/headers) que un cliente pudiera falsificar.
 */
test("render/route.ts pasa a assertCanGenerate el `user` server-side (supabase.auth.getUser()), no un valor del cliente", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /assertCanGenerate\(service,\s*user\.id,\s*videoRequest\.mode,\s*user\)/,
    "el 4to argumento debe ser exactamente `user` — el objeto ya autenticado por supabase.auth.getUser(), no un campo derivado de la request",
  );
  const getUserIndex = source.indexOf("supabase.auth.getUser()");
  const assertCanGenerateIndex = source.indexOf("assertCanGenerate(service, user.id, videoRequest.mode, user)");
  assert.ok(getUserIndex !== -1 && getUserIndex < assertCanGenerateIndex, "`user` debe originarse en supabase.auth.getUser(), antes de usarse en el bypass");
});
