import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Pruebas estructurales de las rutas (los archivos bajo "[id]" no pueden
 * ejecutarse con `node --test` — ver render-route-cas.test.ts). El
 * comportamiento (CAS, idempotencia, recálculo server-side) está probado
 * en confirm-production.test.ts contra la lógica real.
 */
const API = path.join(__dirname, "..", "..", "..", "app", "api", "generate", "[id]");
const read = (...p: string[]) => fs.readFileSync(path.join(API, ...p), "utf-8");

test("confirm-production/route.ts delega en confirmLongFormProduction y exige acceso beta de Long Form", () => {
  const source = read("confirm-production", "route.ts");
  assert.match(source, /confirmLongFormProduction\(createServiceClient\(\)/);
  assert.match(source, /canAccessLongFormBeta\(user\)/);
  assert.doesNotMatch(source, /\.plan\b(?!\s*[,}:])/, "el body del cliente nunca aporta un plan");
});

test("render/route.ts: exige long_form_confirmed_at para mode=\"long_form\" antes de la transición a processing", () => {
  const source = read("render", "route.ts");
  const gate = source.indexOf('videoRequest.mode === "long_form" && !videoRequest.long_form_confirmed_at');
  const cas = source.indexOf('status: "processing"');
  assert.ok(gate > 0, "gate presente");
  assert.ok(gate < cas, "el gate corre ANTES del UPDATE a processing");
});

test("render/route.ts envía el mode al worker (render.yml da timeout/credenciales de Long Form solo con mode=long_form)", () => {
  assert.match(read("render", "route.ts"), /worker\.trigger\(\{[^}]*mode: videoRequest\.mode/);
});
