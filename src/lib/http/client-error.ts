/**
 * Clasifica un error atrapado en el cliente tras llamar a una de nuestras
 * propias APIs (GenerateButton y similares) — nunca debe llegar a la
 * pantalla el mensaje crudo que arroja fetch() cuando la conexión falla a
 * nivel de red, antes de recibir ninguna respuesta del servidor (p. ej.
 * "Failed to fetch" en Chrome/Android, "NetworkError when attempting to
 * fetch resource." en Firefox, "Load failed" en Safari). La spec de Fetch
 * garantiza que ese fallo SIEMPRE llega como un TypeError — a diferencia
 * del error ya clasificado que el propio servidor devuelve (vía
 * safeParseJsonResponse -> classifyScriptError, un `Error` normal con un
 * mensaje ya seguro en español), que se deja pasar tal cual.
 *
 * Importante para la UX: el mensaje nunca sugiere que la solicitud se
 * perdió. Si fetch() nunca llegó a completarse, el servidor no llegó a
 * tocar la fila — sigue exactamente en el estado anterior (blocker real
 * de QA 2026-09-25: una solicitud "pending" que mostraba "Failed to
 * fetch" seguía siendo, verificado en base de datos, la misma solicitud
 * "pending" de siempre) y reintentar es seguro.
 */
export function classifyClientFetchError(error: unknown): string {
  if (error instanceof TypeError) {
    return "No se pudo conectar con el servidor. Revisa tu conexión a internet e inténtalo de nuevo — tu solicitud no se perdió.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Error inesperado. Intenta de nuevo.";
}
