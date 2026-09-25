import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { MissingEnvVarError } from "@/lib/env-errors";
import { classifyScriptError, logScriptError, scriptErrorCode } from "./script-error";

/**
 * Regresión del Blocker #3 de QA (2026-09-25): un reintento real de
 * "Generar guion" en producción marcó la solicitud "failed" con el
 * mensaje MÁS GENÉRICO posible ("No se pudo completar este intento...",
 * el fallback de renderFailureMessage — ver job-error.test.ts), sin
 * ninguna pista sobre si la causa fue la API key de Anthropic, el modelo
 * configurado, un límite de tasa, o algo completamente distinto. Antes
 * de este fix, un Anthropic.AuthenticationError/NotFoundError/etc. real
 * caía en la rama genérica `error instanceof Error` de logScriptError,
 * que solo registraba `error.name` — casi siempre el inútil "Error"
 * genérico de la clase base, nunca el status HTTP real de Anthropic.
 */
/**
 * Misma fábrica que usa el propio SDK internamente (APIError.generate)
 * para construir la subclase correcta a partir de un status HTTP real —
 * más fiel que instanciar cada subclase a mano, y evita reimplementar su
 * lógica de despacho por status.
 */
function makeAnthropicError(status: number, type: string): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(status, { error: { message: "detalle crudo del proveedor", type } }, "detalle crudo del proveedor", new Headers());
}

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

test("scriptErrorCode distingue las categorías reales de Anthropic entre sí (401/403/404/429/5xx)", () => {
  assert.equal(scriptErrorCode(makeAnthropicError(401, "authentication_error")), "anthropic_authentication_error");
  assert.equal(scriptErrorCode(makeAnthropicError(403, "permission_error")), "anthropic_permission_denied");
  assert.equal(scriptErrorCode(makeAnthropicError(404, "not_found_error")), "anthropic_model_not_found");
  assert.equal(scriptErrorCode(makeAnthropicError(429, "rate_limit_error")), "anthropic_rate_limited");
  assert.equal(scriptErrorCode(makeAnthropicError(500, "api_error")), "anthropic_server_error");
  assert.equal(scriptErrorCode(new Anthropic.APIConnectionTimeoutError()), "anthropic_timeout");
  assert.equal(scriptErrorCode(new Anthropic.APIConnectionError({ message: "network down" })), "anthropic_connection_error");
  assert.equal(scriptErrorCode(new Error("algo genérico sin relación con Anthropic")), "unknown");
});

test("classifyScriptError da mensajes DISTINTOS para auth/modelo-no-encontrado vs. límite de tasa (antes ambos caían en el mismo genérico)", () => {
  const authMessage = classifyScriptError(makeAnthropicError(401, "authentication_error"));
  const notFoundMessage = classifyScriptError(makeAnthropicError(404, "not_found_error"));
  const rateLimitMessage = classifyScriptError(makeAnthropicError(429, "rate_limit_error"));

  assert.match(authMessage, /revisión de configuración/);
  assert.match(notFoundMessage, /revisión de configuración/);
  assert.match(rateLimitMessage, /demasiadas solicitudes/);
  assert.notEqual(authMessage.replace(/\(Código: [0-9a-f]{8}\)$/, ""), rateLimitMessage.replace(/\(Código: [0-9a-f]{8}\)$/, ""));

  for (const message of [authMessage, notFoundMessage, rateLimitMessage]) {
    assert.match(message, /\(Código: [0-9a-f]{8}\)$/, "todo mensaje debe llevar el código de diagnóstico para poder correlacionarlo con los logs");
  }
});

test("classifyScriptError/logScriptError reutilizan EL MISMO diagnosticId cuando se les pasa uno explícito", () => {
  const diagnosticId = "a1b2c3d4";
  const message = classifyScriptError(new Error("boom"), diagnosticId);
  assert.match(message, new RegExp(`\\(Código: ${diagnosticId}\\)$`));

  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    logScriptError("POST /script", new Error("boom"), diagnosticId);
  } finally {
    console.error = original;
  }
  assert.ok(String(calls[0][0]).includes(diagnosticId));
});

test("logScriptError registra status/type de Anthropic (seguro, nunca el .message crudo) para poder diagnosticar sin adivinar", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);

  try {
    logScriptError("generateScriptForRequest", makeAnthropicError(404, "not_found_error"));
  } finally {
    console.error = original;
  }

  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /anthropic_model_not_found/);
  const detail = calls[0][1] as { status?: number; type?: string };
  assert.equal(detail.status, 404);
  assert.equal(detail.type, "not_found_error");
  assert.ok(!JSON.stringify(calls).includes("detalle crudo del proveedor"), "nunca debe registrarse el .message crudo del error de Anthropic");
});
