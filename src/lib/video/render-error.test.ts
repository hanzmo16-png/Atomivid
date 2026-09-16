import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingEnvVarError } from "@/lib/env-errors";
import { classifyRenderError, generateDiagnosticId, logRenderError } from "./render-error";

test("generateDiagnosticId da identificadores cortos y distintos en cada llamada", () => {
  const a = generateDiagnosticId();
  const b = generateDiagnosticId();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test("classifyRenderError incluye el identificador de diagnóstico en el mensaje", () => {
  const id = "abc12345";
  const message = classifyRenderError(new Error("algo interno"), id);
  assert.ok(message.includes(id));
});

test("classifyRenderError menciona el nombre exacto de la variable ausente", () => {
  const id = "abc12345";
  const message = classifyRenderError(new MissingEnvVarError("GH_WORKER_TOKEN"), id);
  assert.ok(message.includes("GH_WORKER_TOKEN"));
  assert.ok(message.includes(id));
});

test("classifyRenderError nunca expone el mensaje crudo del error", () => {
  const id = "abc12345";
  const rawMessage = "No se pudo activar el worker de GitHub Actions (HTTP 401): bad credentials";
  const message = classifyRenderError(new Error(rawMessage), id);
  assert.ok(!message.includes(rawMessage));
  assert.ok(!message.includes("bad credentials"));
});

test("logRenderError registra el código de un error de Supabase (objeto plano, no Error)", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    logRenderError("test", { message: "duplicate key", code: "23505" }, "abc12345");
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify(calls);
  assert.ok(serialized.includes("23505"));
});

test("classifyRenderError (el mensaje que sí ve el cliente) nunca expone un valor que aparezca en el error crudo", () => {
  // Simula el peor caso: un error cuyo mensaje sí trae algo sensible (por
  // un bug en otro punto del código, p. ej.). El límite de seguridad real
  // está en classifyRenderError, no en logRenderError — el log de servidor
  // puede y debe registrar el detalle completo para poder diagnosticar,
  // pero lo que se le devuelve al cliente jamás debe incluirlo.
  const FAKE_TOKEN = "super-secret-value-should-never-leak-9f8a7b";
  const id = "abc12345";
  const message = classifyRenderError(new Error(`fallo con token ${FAKE_TOKEN} incluido`), id);
  assert.ok(!message.includes(FAKE_TOKEN));
});
