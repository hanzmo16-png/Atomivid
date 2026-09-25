import Anthropic from "@anthropic-ai/sdk";
import { ProviderConfigurationError } from "@/lib/providers/production";
import { MissingEnvVarError } from "@/lib/env-errors";
import { ScriptQualityError } from "@/lib/video/script-quality";
import { generateDiagnosticId } from "@/lib/video/render-error";

/**
 * Categoría estable para los logs del servidor — nunca se muestra al
 * usuario, pero permite buscar/filtrar sin depender de parsear texto
 * libre. Blocker real de QA (2026-09-25): antes de esto, cualquier
 * excepción que no fuera MissingEnvVarError/ScriptQualityError se
 * registraba solo como `error.name` (casi siempre el genérico "Error"),
 * perdiendo por completo si la causa real era Anthropic rechazando la
 * API key (401), el modelo configurado (ANTHROPIC_SCRIPT_MODEL) no
 * existir para la cuenta (404), un límite de tasa (429), o una caída del
 * proveedor (5xx) — las cuatro tienen remedios completamente distintos.
 */
export type ScriptErrorCode =
  | "provider_not_configured"
  | "missing_env_var"
  | "quality_rejected_fallback_provider"
  | "quality_rejected_word_count"
  | "quality_rejected_generic"
  | "anthropic_authentication_error"
  | "anthropic_permission_denied"
  | "anthropic_model_not_found"
  | "anthropic_rate_limited"
  | "anthropic_connection_error"
  | "anthropic_timeout"
  | "anthropic_server_error"
  | "anthropic_api_error"
  | "unknown";

export function scriptErrorCode(error: unknown): ScriptErrorCode {
  if (error instanceof ProviderConfigurationError) return "provider_not_configured";
  if (error instanceof MissingEnvVarError) return "missing_env_var";
  if (error instanceof ScriptQualityError) {
    if (error.result.issue === "fallback_provider") return "quality_rejected_fallback_provider";
    if (error.result.issue === "word_count_out_of_range") return "quality_rejected_word_count";
    return "quality_rejected_generic";
  }
  // APIConnectionTimeoutError extiende APIConnectionError — hay que
  // comprobarla primero, o nunca se distinguiría de la genérica.
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "anthropic_timeout";
  if (error instanceof Anthropic.APIConnectionError) return "anthropic_connection_error";
  if (error instanceof Anthropic.AuthenticationError) return "anthropic_authentication_error";
  if (error instanceof Anthropic.PermissionDeniedError) return "anthropic_permission_denied";
  // El caso más accionable de todos: un ANTHROPIC_SCRIPT_MODEL mal
  // escrito o descontinuado da 404, no un error de credenciales — sin
  // distinguirlo, se ve idéntico a "la API key es inválida" en los logs.
  if (error instanceof Anthropic.NotFoundError) return "anthropic_model_not_found";
  if (error instanceof Anthropic.RateLimitError) return "anthropic_rate_limited";
  if (error instanceof Anthropic.InternalServerError) return "anthropic_server_error";
  if (error instanceof Anthropic.APIError) return "anthropic_api_error";
  return "unknown";
}

/**
 * Mensaje seguro para el cliente — nunca el mensaje crudo del proveedor de
 * guion (podría nombrar el proveedor o detalles internos, algo que este
 * proyecto evita deliberadamente exponer al usuario en otras pantallas).
 * Para variable de entorno ausente sí se incluye su nombre exacto, que no
 * es secreto y es justo lo que hay que corregir. Para un guion rechazado
 * por calidad, el mensaje distingue explícitamente "se usó un respaldo,
 * no el proveedor real" de "el resultado no pasó el control de calidad" —
 * en ambos casos deja claro que hay que reintentar, nunca presenta el
 * contenido rechazado como si fuera el resultado final.
 *
 * Mismo patrón que classifyRenderError (render-error.ts): cada mensaje
 * lleva un código corto de diagnóstico no determinista, generado una vez
 * por intento y reutilizado también en logScriptError — así un reporte
 * de usuario ("vi el Código: a1b2c3d4") se puede correlacionar
 * directamente con la línea de log correspondiente sin exponer nada
 * sensible en la UI.
 */
export function classifyScriptError(error: unknown, diagnosticId: string = generateDiagnosticId()): string {
  const suffix = ` (Código: ${diagnosticId})`;

  if (error instanceof ProviderConfigurationError) return error.message + suffix;
  if (error instanceof MissingEnvVarError) {
    return `Falta configurar ${error.varName} en el servidor. Contacta al soporte.${suffix}`;
  }
  if (error instanceof ScriptQualityError) {
    if (error.result.issue === "fallback_provider") {
      return `No se pudo generar el guion con el proveedor de IA principal — se usó contenido de respaldo, que no es apto para publicar. Vuelve a intentarlo en unos minutos.${suffix}`;
    }
    if (error.result.issue === "word_count_out_of_range") return `El guion no corresponde a la duración solicitada. Revísalo antes de generar la narración.${suffix}`;
    return `El guion generado no cumplió los estándares de calidad (repetición o contenido genérico). Pulsa reintentar — cada intento genera contenido distinto.${suffix}`;
  }

  const code = scriptErrorCode(error);
  if (
    code === "anthropic_authentication_error" ||
    code === "anthropic_permission_denied" ||
    code === "anthropic_model_not_found"
  ) {
    return `El servicio de generación de guiones necesita revisión de configuración. Contacta al soporte; repetir ahora no resolverá el problema.${suffix}`;
  }
  if (code === "anthropic_rate_limited") {
    return `El servicio de generación de guiones está recibiendo demasiadas solicitudes en este momento. Tu solicitud sigue guardada; espera unos minutos y reintenta.${suffix}`;
  }
  if (code === "anthropic_timeout" || code === "anthropic_connection_error") {
    return `No se pudo contactar al servicio de generación de guiones (problema de red o tiempo de espera agotado). Intenta de nuevo en un momento.${suffix}`;
  }
  if (code === "anthropic_server_error") {
    return `El servicio de generación de guiones no está disponible en este momento. Intenta de nuevo en unos minutos.${suffix}`;
  }

  return `No se pudo generar el guion en este momento. Intenta de nuevo.${suffix}`;
}

/**
 * Log de servidor seguro: incluye la categoría estable (scriptErrorCode)
 * y el mismo código de diagnóstico que ve el usuario, más los únicos
 * detalles técnicos que un error de Anthropic expone sin ser secretos
 * (status HTTP y su propio `type` de categoría, p. ej. "rate_limit_error")
 * — nunca su `.message`, que puede incluir eco de la petición.
 */
export function logScriptError(context: string, error: unknown, diagnosticId: string = generateDiagnosticId()): void {
  const code = scriptErrorCode(error);
  const prefix = `[script] [${diagnosticId}] ${context}: ${code}`;

  if (error instanceof Anthropic.APIError) {
    console.error(prefix, { status: error.status, type: error.type });
    return;
  }
  if (error instanceof MissingEnvVarError) {
    console.error(prefix, { varName: error.varName });
    return;
  }
  if (error instanceof ScriptQualityError) {
    console.error(prefix, { issue: error.result.issue });
    return;
  }
  if (error instanceof ProviderConfigurationError) {
    console.error(prefix);
    return;
  }
  if (error instanceof Error) {
    console.error(prefix, { errorName: error.name });
    return;
  }
  console.error(prefix);
}
