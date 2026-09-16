/**
 * Parsea la respuesta de un fetch() a una API propia sin asumir nunca que
 * el cuerpo es JSON válido. `response.json()` a secas revienta con
 * "Unexpected end of JSON input" si el cuerpo llega vacío o truncado — algo
 * que puede pasar por causas fuera del control del código de la ruta (p.
 * ej. la función serverless se corta por timeout antes de terminar de
 * escribir la respuesta). Nunca debe verse ese error crudo del navegador:
 * siempre se traduce a un mensaje seguro y comprensible.
 */
const GENERIC_ERROR_MESSAGE = "No se pudo completar la acción. Intenta de nuevo en un momento.";

export type SafeJsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export async function safeParseJsonResponse<T = unknown>(
  response: Response,
): Promise<SafeJsonResult<T>> {
  const status = response.status;

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, status, error: GENERIC_ERROR_MESSAGE };
  }

  if (!text) {
    return { ok: false, status, error: GENERIC_ERROR_MESSAGE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status, error: GENERIC_ERROR_MESSAGE };
  }

  if (!response.ok) {
    const serverMessage = (parsed as { error?: unknown } | null)?.error;
    const error = typeof serverMessage === "string" && serverMessage ? serverMessage : GENERIC_ERROR_MESSAGE;
    return { ok: false, status, error };
  }

  return { ok: true, status, data: parsed as T };
}
