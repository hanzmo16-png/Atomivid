import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingEnvVarError } from "@/lib/env-errors";
import { classifyScriptError, logScriptError } from "./script-error";

test("classifyScriptError menciona el nombre exacto de la variable ausente", () => {
  const message = classifyScriptError(new MissingEnvVarError("ANTHROPIC_API_KEY"));
  assert.ok(message.includes("ANTHROPIC_API_KEY"));
});

test("classifyScriptError nunca expone el mensaje crudo de un error del proveedor", () => {
  const rawProviderMessage = "401 authentication_error: invalid x-api-key header";
  const message = classifyScriptError(new Error(rawProviderMessage));
  assert.ok(!message.includes(rawProviderMessage));
  assert.ok(message.length > 0);
});

test("classifyScriptError da un mensaje de reserva para errores desconocidos", () => {
  const message = classifyScriptError("algo que ni siquiera es un Error");
  assert.ok(message.length > 0);
});

test("logScriptError nunca imprime el mensaje crudo del proveedor", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  const rawProviderMessage = "401 authentication_error: invalid x-api-key header sk-ant-FAKE";
  try {
    logScriptError("generateScriptForRequest", new Error(rawProviderMessage));
    logScriptError("generateScriptForRequest", new MissingEnvVarError("ANTHROPIC_API_KEY"));
  } finally {
    console.error = original;
  }

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(rawProviderMessage));
  assert.equal(calls.length, 2);
});
