import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * RC mission "LONG FORM RC FINAL HARDENING" sección 36 (confirmación
 * atómica). Igual que render-route-cas.test.ts, este archivo vive fuera
 * de app/api/generate/[id]/ a propósito: "[id]" se interpreta como una
 * clase de caracteres en el glob que usa `node --test`, así que un test
 * colocado ahí dentro nunca se ejecuta. Se prueba a nivel de código
 * fuente (estructural) en vez de un mock de Supabase completo porque la
 * garantía real (doble clic → una sola confirmación) depende de
 * semántica de UPDATE condicional de Postgres, la misma razón que ya
 * documenta render-route-cas.test.ts.
 */
const CONFIRM_ROUTE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "api",
  "generate",
  "[id]",
  "confirm-production",
  "route.ts",
);
const RENDER_ROUTE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "api",
  "generate",
  "[id]",
  "render",
  "route.ts",
);

test("confirm-production/route.ts: el UPDATE que fija long_form_confirmed_at está condicionado a que siga en NULL (CAS)", () => {
  const source = fs.readFileSync(CONFIRM_ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /\.update\(\{\s*long_form_production_plan:\s*plan,\s*long_form_confirmed_at:\s*confirmedAt\s*\}\)[\s\S]*?\.is\("long_form_confirmed_at",\s*null\)/,
    "el UPDATE de confirmación debe seguir condicionado a .is(\"long_form_confirmed_at\", null)",
  );
});

test("confirm-production/route.ts: una confirmación ya existente se devuelve tal cual (idempotente), nunca se sobreescribe", () => {
  const source = fs.readFileSync(CONFIRM_ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /if\s*\(data\.long_form_confirmed_at\s*&&\s*isProductionPlan\(data\.long_form_production_plan\)\)/,
    "debe seguir devolviendo la confirmación existente sin recalcular ni reescribir",
  );
});

test("confirm-production/route.ts: el plan SIEMPRE se recalcula server-side a partir del guion guardado, nunca se confía en un plan enviado por el cliente", () => {
  const source = fs.readFileSync(CONFIRM_ROUTE_PATH, "utf-8");
  assert.doesNotMatch(
    source,
    /body\.plan|body\["plan"\]|request\.plan/,
    "el body del cliente nunca debe proveer directamente el ProductionPlan a persistir",
  );
  assert.match(
    source,
    /const plan = computeProductionPlan\(\{/,
    "el plan debe calcularse con computeProductionPlan() en el servidor",
  );
});

test("confirm-production/route.ts: rechaza estrategias que no sean una de las 3 reales", () => {
  const source = fs.readFileSync(CONFIRM_ROUTE_PATH, "utf-8");
  assert.match(source, /isVisualStrategyValue\(strategy\)/);
});

test("render/route.ts: exige long_form_confirmed_at para mode=\"long_form\" antes de permitir la transición a processing", () => {
  const source = fs.readFileSync(RENDER_ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /videoRequest\.mode === "long_form" && !videoRequest\.long_form_confirmed_at/,
    "debe seguir bloqueando el render de long_form sin confirmación previa",
  );
});
