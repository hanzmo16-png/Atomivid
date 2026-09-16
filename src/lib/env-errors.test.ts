import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingEnvVarError } from "./env-errors";

test("MissingEnvVarError incluye el nombre exacto de la variable en el mensaje", () => {
  const err = new MissingEnvVarError("STRIPE_SECRET_KEY");
  assert.ok(err.message.includes("STRIPE_SECRET_KEY"));
  assert.equal(err.varName, "STRIPE_SECRET_KEY");
});

test("MissingEnvVarError es instancia de Error y tiene name propio", () => {
  const err = new MissingEnvVarError("STRIPE_PRICE_ID");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "MissingEnvVarError");
});

test("MissingEnvVarError nunca incluye un valor, solo el nombre de la variable", () => {
  const err = new MissingEnvVarError("SUPABASE_SERVICE_ROLE_KEY");
  // El mensaje debe mencionar el nombre pero no puede haber ningún otro
  // dato que no sea texto fijo + el nombre — no hay valor que filtrar aquí,
  // pero esta prueba documenta la garantía explícitamente.
  assert.equal(
    err.message,
    `Falta la variable de entorno "SUPABASE_SERVICE_ROLE_KEY" (o está vacía). Configúrala en Vercel → Settings → Environment Variables para el entorno Production y vuelve a desplegar.`,
  );
});
