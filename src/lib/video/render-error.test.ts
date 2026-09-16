import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingEnvVarError } from "@/lib/env-errors";
import { GitHubWorkerDispatchError } from "@/lib/worker/github-actions";
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

/**
 * Regresión exacta del incidente en producción (Código: 30451999): un
 * fallo al disparar el worker de GitHub Actions (token sin permisos,
 * expirado, o repo mal configurado) caía en el mensaje genérico "Intenta
 * de nuevo en un momento" — indistinguible de un fallo transitorio real, y
 * sin ninguna pista accionable sin poder leer los logs del servidor.
 */
test("classifyRenderError da un mensaje específico para GH_WORKER_TOKEN inválido/expirado (401/403)", () => {
  const id = "abc12345";
  for (const status of [401, 403]) {
    const message = classifyRenderError(
      new GitHubWorkerDispatchError(status, "bad credentials"),
      id,
    );
    assert.ok(message.includes("GH_WORKER_TOKEN"));
    assert.ok(message.includes(id));
    assert.ok(!message.includes("bad credentials"));
  }
});

test("classifyRenderError da un mensaje específico para GH_WORKER_REPO incorrecto (404)", () => {
  const id = "abc12345";
  const message = classifyRenderError(new GitHubWorkerDispatchError(404, "Not Found"), id);
  assert.ok(message.includes("GH_WORKER_REPO"));
  assert.ok(message.includes(id));
  assert.ok(!message.includes("Not Found"));
});

test("classifyRenderError incluye el status HTTP (no el cuerpo) para otros fallos de GitHub", () => {
  const id = "abc12345";
  const message = classifyRenderError(
    new GitHubWorkerDispatchError(500, "internal server error detail"),
    id,
  );
  assert.ok(message.includes("500"));
  assert.ok(!message.includes("internal server error detail"));
});
