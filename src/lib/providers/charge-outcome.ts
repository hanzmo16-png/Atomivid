/**
 * ¿Pudo cobrarse una llamada fallida a un proveedor de pago?
 *
 *  - "not_sent": la solicitud INEQUÍVOCAMENTE no llegó al proveedor (no se
 *    resolvió el nombre, se rechazó la conexión TCP, falló el handshake TLS,
 *    URL inválida). Costo cero; puede repetirse.
 *  - "rejected": el proveedor respondió con un status que documenta un
 *    rechazo ANTES de generar (lista cerrada, ver REJECTED_STATUSES). Costo
 *    cero; repetir no suele servir.
 *  - "uncertain": todo lo demás. Una conexión cortada (ECONNRESET, socket
 *    cerrado), un timeout, un 5xx o un 408 NO prueban que el servidor no
 *    procesó (y cobró) la solicitud. Nunca se repite automáticamente.
 *
 * Por defecto todo es incierto: solo se concede costo cero con evidencia.
 */
export type ChargeOutcome = "not_sent" | "rejected" | "uncertain";

/**
 * Códigos de Node/undici que ocurren antes de escribir un solo byte de la
 * solicitud HTTP. ECONNRESET, EPIPE, UND_ERR_SOCKET, ETIMEDOUT y
 * UND_ERR_HEADERS_TIMEOUT no están: pueden ocurrir con la solicitud ya enviada.
 */
const PRE_SEND_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Status con los que OpenAI y ElevenLabs rechazan la solicitud sin generar:
 * validación (400/413/415/422), autenticación/permiso (401/403), recurso
 * inexistente (404) y límite de velocidad (429). 408, 409, 5xx y cualquier
 * otro → incierto.
 */
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

export function httpStatusOutcome(status: number): ChargeOutcome {
  return REJECTED_STATUSES.has(status) ? "rejected" : "uncertain";
}

function codeOf(value: unknown): string | undefined {
  if (value && typeof value === "object" && "code" in value && typeof (value as { code: unknown }).code === "string") {
    return (value as { code: string }).code;
  }
  return undefined;
}

/**
 * Clasifica la excepción de un `fetch` que no devolvió respuesta. Recorre la
 * cadena `cause` (undici envuelve el error real en `TypeError: fetch failed`)
 * y los `errors` de un AggregateError (varios destinos: TODOS deben ser
 * previos al envío). Sin código reconocido → incierto.
 */
export function fetchFailureOutcome(err: unknown): ChargeOutcome {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): ChargeOutcome => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return "uncertain";
    seen.add(value);
    const code = codeOf(value);
    if (code && PRE_SEND_CODES.has(code)) return "not_sent";
    const errors = (value as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && errors.every((e) => visit(e, depth + 1) === "not_sent")) return "not_sent";
    return visit((value as { cause?: unknown }).cause, depth + 1);
  };
  return visit(err, 0);
}
