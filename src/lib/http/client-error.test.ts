import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClientFetchError } from "./client-error";

/**
 * Regresión del Blocker #2 de QA (2026-09-25): GenerateButton mostraba el
 * "Failed to fetch" crudo del navegador debajo del botón "Generar guion"
 * en vez de un mensaje útil, y ese texto podía malinterpretarse como que
 * la solicitud se había perdido.
 */

test("un TypeError de fetch() (fallo de red real, nunca llegó respuesta) se traduce a un mensaje útil en español", () => {
  const message = classifyClientFetchError(new TypeError("Failed to fetch"));
  assert.equal(
    message,
    "No se pudo conectar con el servidor. Revisa tu conexión a internet e inténtalo de nuevo — tu solicitud no se perdió.",
  );
});

test("cualquier TypeError de fetch (Firefox/Safari usan otro texto) se clasifica igual — nunca por coincidencia de string", () => {
  const firefox = classifyClientFetchError(new TypeError("NetworkError when attempting to fetch resource."));
  const safari = classifyClientFetchError(new TypeError("Load failed"));
  assert.match(firefox, /No se pudo conectar con el servidor/);
  assert.match(safari, /No se pudo conectar con el servidor/);
});

test("un Error ya clasificado por el servidor (safeParseJsonResponse/classifyScriptError) se deja pasar sin modificar", () => {
  const serverMessage = "El guion generado no cumplió los estándares de calidad (repetición o contenido genérico). Pulsa reintentar — cada intento genera contenido distinto.";
  const message = classifyClientFetchError(new Error(serverMessage));
  assert.equal(message, serverMessage);
});

test("un valor no-Error lanzado cae al mensaje genérico existente", () => {
  assert.equal(classifyClientFetchError("boom"), "Error inesperado. Intenta de nuevo.");
  assert.equal(classifyClientFetchError(undefined), "Error inesperado. Intenta de nuevo.");
});
