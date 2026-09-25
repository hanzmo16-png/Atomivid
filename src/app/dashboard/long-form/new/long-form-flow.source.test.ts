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
  const match = source.match(/<textarea id="open_questions"[^>]*\/>/);
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
    /if \(sources\.length === 0\) \{\s*redirect\(/,
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
    /catch \(err\) \{[\s\S]{0,200}redirect\(`\/dashboard\/long-form\/new\?error=/,
    "un fallo del proveedor debe redirigir con un mensaje de error visible en la misma página, no perderse en silencio",
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
