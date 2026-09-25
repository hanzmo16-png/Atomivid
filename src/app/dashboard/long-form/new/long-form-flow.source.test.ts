import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regresión del QA real (2026-09-25, "GENERAR GUION NO HACE NADA EN
 * PRODUCTION"): el submit de /dashboard/long-form/new fallaba en
 * silencio — ni loading, ni navegación, ni error, ni éxito. Confirmado
 * leyendo producción vía scripts/diagnose-long-form-request.ts: CERO
 * filas mode='long_form' existen — la función se interrumpía antes de
 * llegar al insert o al catch/redirect de error de actions.ts.
 *
 * Causa raíz: page.tsx no declaraba `export const maxDuration`, así que
 * el Server Action heredaba el límite por defecto de la plataforma —
 * exactamente la misma causa raíz ya documentada y corregida para el
 * guion de Reel en src/app/api/generate/[id]/script/route.ts (ver su
 * propio comentario). generateDocumentaryScript() pide hasta 8000 tokens
 * de salida en una sola llamada real a Claude, sin reintentos.
 *
 * actions.ts/page.tsx hacen I/O real (Supabase, Anthropic) — mismo motivo
 * estructural que justifica avatar-flow.source.test.ts para no requerir
 * un runtime de Server Actions completo aquí.
 */
const PAGE_PATH = path.join(__dirname, "page.tsx");
const ACTIONS_PATH = path.join(__dirname, "actions.ts");
const SUBMIT_BUTTON_PATH = path.join(__dirname, "SubmitButton.tsx");

function readPage(): string {
  return fs.readFileSync(PAGE_PATH, "utf-8");
}
function readActions(): string {
  return fs.readFileSync(ACTIONS_PATH, "utf-8");
}

test("page.tsx declara maxDuration explícito — los Server Actions heredan el de la página, nunca el de actions.ts", () => {
  const source = readPage();
  assert.match(
    source,
    /export const maxDuration = 120/,
    "sin esto, Vercel corta la función a medias antes de que createLongFormVideoRequest llegue a insertar la fila o a su propio error — el submit se ve como si no hiciera nada",
  );
});

test("page.tsx usa SubmitButton (useFormStatus) en vez de un <Button type=\"submit\"> estático sin estado", () => {
  const source = readPage();
  assert.match(source, /import\s*\{\s*SubmitButton\s*\}\s*from\s*"\.\/SubmitButton"/);
  assert.match(source, /<SubmitButton\s*\/>/);
  assert.ok(
    !/<Button type="submit" className="w-full">\s*Generar guion/.test(source),
    "el botón estático sin estado de carga no debe seguir en page.tsx",
  );
});

test("SubmitButton.tsx: usa useFormStatus para mostrar estado de carga y protegerse contra doble submit", () => {
  const source = fs.readFileSync(SUBMIT_BUTTON_PATH, "utf-8");
  assert.match(source, /"use client"/);
  assert.match(source, /import\s*\{\s*useFormStatus\s*\}\s*from\s*"react-dom"/);
  assert.match(source, /const \{ pending \} = useFormStatus\(\)/);
  assert.match(source, /loading=\{pending\}/, "debe mostrar el spinner ya establecido por Button.tsx mientras está pendiente");
  assert.match(source, /disabled=\{pending\}/, "el botón debe deshabilitarse mientras está pendiente, para que un segundo click no dispare un segundo submit");
  assert.match(source, /pending \? "Generando guion…" : "Generar guion"/);
});

test('open_questions sigue siendo opcional: el <textarea> no tiene el atributo "required"', () => {
  const source = readPage();
  const match = source.match(/<textarea\s+id="open_questions"[\s\S]*?\/>/);
  assert.ok(match, "no se encontró el textarea de open_questions");
  assert.ok(!match![0].includes("required"), 'open_questions nunca debe volver a marcarse required — el campo está explícitamente etiquetado "(opcional)"');
});

test("sources sigue siendo obligatorio en el HTML (required) Y en el servidor (al menos 1 fuente parseada)", () => {
  const pageSource = readPage();
  const sourcesMatch = pageSource.match(/<textarea\s+id="sources"[\s\S]*?\/>/);
  assert.ok(sourcesMatch, "no se encontró el textarea de sources");
  assert.ok(sourcesMatch![0].includes("required"), "el HTML debe seguir marcando sources como required");

  const actionsSource = readActions();
  assert.match(
    actionsSource,
    /if \(sources\.length === 0\) \{\s*longFormFormRedirect\(/,
    "un documental factual de Long Form nunca debe generarse sin al menos una fuente verificada — no relajar esta regla",
  );
});

test("duration_minutes=3 es válido: el contrato server-side usa < (estricto), no <=", () => {
  const source = readActions();
  assert.match(source, /const MIN_DURATION_MINUTES = 3/);
  assert.match(
    source,
    /durationMinutes < MIN_DURATION_MINUTES/,
    "3 minutos debe seguir siendo válido (comparación estricta, no <=) — el contrato visible en la UI dice 3-15 minutos",
  );
});

test("createLongFormVideoRequest: la generación real (Anthropic) está envuelta en try/catch con redirect de error, fuera del try (nunca se traga el error en silencio)", () => {
  const source = readActions();
  assert.match(
    source,
    /try \{\s*beats = await generateDocumentaryScript\(/,
    "la llamada real al proveedor debe seguir envuelta en try/catch para convertir cualquier fallo en un error visible, nunca en un submit silencioso",
  );
  assert.match(
    source,
    /catch \(err\) \{[\s\S]{0,200}longFormFormRedirect\(message, submittedFields\)/,
    "un fallo del proveedor debe redirigir con un mensaje de error visible en la misma página (y los valores ya escritos), no perderse en silencio",
  );
});

test("createLongFormVideoRequest: éxito navega al historial (created=1) — Long Form nunca redirige a una pantalla de revisión de guion como Reel", () => {
  const source = readActions();
  assert.match(source, /redirect\("\/dashboard\?created=1"\)/);
});

test("createLongFormVideoRequest: mode='long_form' y aspect_ratio='16:9' se insertan explícitamente", () => {
  const source = readActions();
  assert.match(source, /mode:\s*"long_form"/);
  assert.match(source, /aspect_ratio:\s*"16:9"/);
});

/**
 * Regresión del QA real (2026-09-25, "duration_seconds CHECK CONSTRAINT +
 * FORM STATE LOST ON ERROR"): el intento real de Hans (3 min = 180s) fue
 * rechazado por Postgres — video_requests_duration_seconds_check
 * (migración 0007) era `duration_seconds > 0 and duration_seconds <=
 * 120`, un límite pensado solo para Reel (ALLOWED_DURATIONS=[30,60,90])
 * nunca extendido para Long Form (contrato real: 3-15 min = 180-900s).
 * Confirmado con una migración real (0018) aplicada y probada contra
 * Postgres 16 real (supabase/migrations/verify/02_duration_check_test.sql):
 * long_form 180s/900s aceptados, 179s/901s rechazados, Reel 90s y Avatar
 * 44s sin cambios, y Reel NUNCA puede usar el rango de Long Form.
 *
 * Estas pruebas verifican, sin necesitar una conexión real a Postgres,
 * que los valores app-level (actions.ts, validation.ts de Reel/Avatar) son
 * coherentes con los límites reales codificados en la migración 0018 — la
 * migración en sí ya se demostró contra Postgres real (ver arriba).
 */
const MIGRATION_0018_PATH = path.join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "0018_long_form_duration_check.sql");
const REEL_VALIDATION_PATH = path.join(__dirname, "..", "..", "new", "validation.ts");

test("migración 0018: el CHECK por modo cubre exactamente 180-900s para long_form y preserva <=120s para los demás modos", () => {
  const migrationSource = fs.readFileSync(MIGRATION_0018_PATH, "utf-8");
  assert.match(migrationSource, /mode = 'long_form' and duration_seconds >= 180 and duration_seconds <= 900/);
  assert.match(migrationSource, /mode <> 'long_form' and duration_seconds > 0 and duration_seconds <= 120/);
  // No debe reaparecer el rango único legacy (sin distinguir por modo) —
  // eso fue exactamente el bug: reducir Long Form al límite de Reel.
  assert.ok(
    !/^\s*check \(duration_seconds > 0 and duration_seconds <= 120\);\s*$/m.test(migrationSource),
    "el CHECK no debe volver a ser un único rango global — eso reduciría Long Form al límite legacy de Reel",
  );
});

test("coherencia: MIN/MAX_DURATION_MINUTES de Long Form (actions.ts) equivalen exactamente al rango 180-900s de la migración 0018", () => {
  const actionsSource = readActions();
  assert.match(actionsSource, /const MIN_DURATION_MINUTES = 3/);
  assert.match(actionsSource, /const MAX_DURATION_MINUTES = 15/);
  // 3 min * 60 = 180s, 15 min * 60 = 900s — deben coincidir con la migración.
  assert.equal(3 * 60, 180);
  assert.equal(15 * 60, 900);
});

test("coherencia: ALLOWED_DURATIONS de Reel (validation.ts) caben todas dentro del límite <=120s que la migración 0018 preserva para modos distintos de long_form", () => {
  const reelValidationSource = fs.readFileSync(REEL_VALIDATION_PATH, "utf-8");
  const match = reelValidationSource.match(/export const ALLOWED_DURATIONS = \[([\d,\s]+)\]/);
  assert.ok(match, "no se encontró ALLOWED_DURATIONS en validation.ts");
  const durations = match![1].split(",").map((n) => Number(n.trim()));
  assert.ok(durations.length > 0);
  for (const d of durations) {
    assert.ok(d > 0 && d <= 120, `ALLOWED_DURATIONS incluye ${d}s, fuera del rango <=120s que la migración 0018 preserva para Reel`);
  }
});

test("classifyInsertError (actions.ts): nunca expone el texto crudo de Postgres al usuario, siempre registra detalle + diagnosticId server-side", () => {
  const source = readActions();
  assert.match(
    source,
    /function classifyInsertError\(error: \{ message: string; code\?: string \}\): string \{/,
    "debe existir un clasificador dedicado para errores de INSERT, igual que classifyScriptError/classifyRenderError para otras etapas",
  );
  assert.match(
    source,
    /generateDiagnosticId\(\)/,
    "debe reutilizar el mismo generador de código de diagnóstico ya usado por run-job.ts/render-error.ts, no uno nuevo",
  );
  assert.match(
    source,
    /console\.error\(`\[atomivid:long-form-insert\]/,
    "el detalle técnico completo (incluyendo error.code) debe seguir registrándose server-side, nunca perderse",
  );
  assert.match(source, /error\.code === "23514"/, "debe distinguir específicamente check_violation (23514) del resto de errores de DB");
  // El texto que SÍ ve el usuario nunca debe mencionar el nombre de la
  // constraint, "relation", "row" ni "Postgres" — solo el genérico + Código.
  const returnStatements = source.match(/return `[^`]*`;/g) ?? [];
  const userFacingInsertMessages = returnStatements.filter((s) => s.includes("Código"));
  assert.ok(userFacingInsertMessages.length >= 2, "classifyInsertError debe tener al menos dos mensajes seguros (check_violation y genérico)");
  for (const msg of userFacingInsertMessages) {
    assert.ok(!/constraint|relation|row|postgres/i.test(msg), `un mensaje visible al usuario no debe mencionar detalle interno de DB: ${msg}`);
  }
  assert.match(source, /longFormFormRedirect\(classifyInsertError\(error\), submittedFields\)/, "el error de insert debe pasar por el clasificador, nunca redirect(error.message) directo");
});

test("longFormFormRedirect (actions.ts): reenvía topic/duration_minutes/sources/open_questions en la URL de error, para que page.tsx los restaure", () => {
  const source = readActions();
  assert.match(
    source,
    /function longFormFormRedirect\(\s*error: string,\s*fields: \{ topic: string; durationMinutes: string; sources: string; openQuestions: string \},?\s*\): never \{/,
  );
  assert.match(source, /new URLSearchParams\(\{\s*error,\s*topic: fields\.topic,\s*duration_minutes: fields\.durationMinutes,\s*sources: fields\.sources,\s*open_questions: fields\.openQuestions,?\s*\}\)/);
  // Los 4 redirects recuperables del formulario (topic/duración/fuentes/
  // proveedor) deben usar el helper, no un redirect(...) crudo que pierda
  // los valores ya escritos.
  const recoverableRedirectCount = (source.match(/longFormFormRedirect\(/g) ?? []).length;
  assert.ok(recoverableRedirectCount >= 5, `se esperaban al menos 5 llamadas a longFormFormRedirect (definición + 4 sitios de uso), se encontraron ${recoverableRedirectCount}`);
});

test("page.tsx: topic/duration_minutes/sources/open_questions se leen de searchParams y se usan como defaultValue", () => {
  const source = readPage();
  assert.match(source, /topic\?: string;\s*duration_minutes\?: string;\s*sources\?: string;\s*open_questions\?: string;/);
  assert.match(source, /defaultValue=\{topic \?\? ""\}/);
  assert.match(source, /defaultValue=\{durationMinutes \?\? "10"\}/);
  assert.match(source, /defaultValue=\{sources \?\? ""\}/);
  assert.match(source, /defaultValue=\{openQuestions \?\? ""\}/);
});
