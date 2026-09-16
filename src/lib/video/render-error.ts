import { randomUUID } from "node:crypto";
import { MissingEnvVarError, InvalidEnvVarError } from "@/lib/env-errors";
import { GitHubWorkerDispatchError, GitHubWorkerNetworkError } from "@/lib/worker/github-actions";

/**
 * Mismo principio que src/lib/video/script-error.ts y
 * src/lib/billing/checkout-error.ts: el cliente nunca ve el mensaje crudo
 * de un fallo al iniciar el render (podría nombrar el worker, el repo de
 * GitHub, o detalles internos) — solo una categoría segura más un
 * identificador de diagnóstico corto para poder correlacionar el reporte
 * del usuario con los logs del servidor, donde sí se registra la causa
 * completa.
 */
const GENERIC_RENDER_ERROR = "No se pudo iniciar la generación del video. Intenta de nuevo en un momento.";

export function generateDiagnosticId(): string {
  return randomUUID().split("-")[0];
}

/**
 * Etapa del endpoint /render en la que ocurrió una excepción no
 * tipada (p. ej. un fallo de red de Supabase, que postgrest-js no
 * atrapa internamente — se propaga como excepción cruda en vez de
 * devolverse como `{ data, error }`). El identificador de diagnóstico
 * (randomUUID) no es determinista ni codifica ningún dato sobre la
 * excepción — su único propósito es correlacionar el reporte del
 * usuario con la línea de log del servidor; sin RenderStageError, esa
 * línea de log existía pero el mensaje que veía el cliente era
 * indistinguible entre "falló leer la solicitud", "falló verificar la
 * suscripción" o "falló marcarla como processing" — las tres caían en
 * el mismo GENERIC_RENDER_ERROR.
 */
export type RenderStage = "fetch_request" | "check_subscription" | "mark_processing";

export class RenderStageError extends Error {
  constructor(
    public readonly stage: RenderStage,
    public readonly stageError: unknown,
  ) {
    super(`Fallo inesperado en la etapa "${stage}" del render`);
    this.name = "RenderStageError";
  }
}

const STAGE_MESSAGES: Record<RenderStage, string> = {
  fetch_request: "No se pudo leer la solicitud (problema de conexión con la base de datos).",
  check_subscription: "No se pudo verificar tu suscripción (problema de conexión con la base de datos).",
  mark_processing: "No se pudo iniciar el render (problema de conexión con la base de datos).",
};

export function classifyRenderError(error: unknown, diagnosticId: string): string {
  if (error instanceof RenderStageError) {
    return `${STAGE_MESSAGES[error.stage]} Intenta de nuevo en un momento. (Código: ${diagnosticId})`;
  }
  if (error instanceof MissingEnvVarError) {
    return `Falta configurar ${error.varName} en el servidor. Contacta al soporte. (Código: ${diagnosticId})`;
  }
  // El mensaje de InvalidEnvVarError ya es seguro por construcción (solo
  // nombre de variable + formato esperado, nunca el valor real) — se
  // reusa tal cual en vez de duplicar el texto aquí.
  if (error instanceof InvalidEnvVarError) {
    return `${error.message} (Código: ${diagnosticId})`;
  }
  if (error instanceof GitHubWorkerNetworkError) {
    return (
      `No se pudo contactar al worker de render (problema de red o tiempo de espera agotado). ` +
      `Intenta de nuevo en un momento. (Código: ${diagnosticId})`
    );
  }
  // El status HTTP de una respuesta de la API de GitHub no es secreto — a
  // diferencia del cuerpo de la respuesta (nunca expuesto al cliente),
  // permite distinguir un problema de configuración permanente (token sin
  // permisos válidos, repo incorrecto) de un fallo realmente transitorio,
  // sin depender de poder leer los logs del servidor.
  if (error instanceof GitHubWorkerDispatchError) {
    if (error.status === 401 || error.status === 403) {
      return (
        `El token del worker de render (GH_WORKER_TOKEN) no tiene permisos válidos o expiró. ` +
        `Contacta al soporte. (Código: ${diagnosticId})`
      );
    }
    if (error.status === 404) {
      return (
        `No se encontró el repositorio configurado para el worker de render (GH_WORKER_REPO). ` +
        `Contacta al soporte. (Código: ${diagnosticId})`
      );
    }
    if (error.status === 422) {
      return (
        `GitHub rechazó la solicitud de disparar el render (datos inválidos). Contacta al soporte. ` +
        `(Código: ${diagnosticId})`
      );
    }
    if (error.status === 429) {
      return (
        `Se alcanzó el límite de peticiones de GitHub. Intenta de nuevo en unos minutos. ` +
        `(Código: ${diagnosticId})`
      );
    }
    if (error.status >= 500) {
      return (
        `GitHub Actions tiene un problema temporal (HTTP ${error.status}). Intenta de nuevo en unos minutos. ` +
        `(Código: ${diagnosticId})`
      );
    }
    return (
      `No se pudo activar el worker de render (HTTP ${error.status}). Intenta de nuevo en un momento. ` +
      `(Código: ${diagnosticId})`
    );
  }
  return `${GENERIC_RENDER_ERROR} (Código: ${diagnosticId})`;
}

/**
 * Log de servidor: aquí sí se registra el mensaje completo (a diferencia
 * de logScriptError, que evita el mensaje crudo del proveedor de guion) —
 * los errores de este flujo son de red/despacho (HTTP del worker,
 * variables ausentes), ya redactados en su origen para no incluir tokens
 * (ver github-actions.ts), así que son seguros de registrar completos y
 * son justo lo que hace falta para diagnosticar sin tener que reproducir.
 */
export function logRenderError(context: string, error: unknown, diagnosticId: string): void {
  if (error instanceof RenderStageError) {
    console.error(`[render] ${context} [${diagnosticId}]: fallo en la etapa "${error.stage}"`);
    // Reusa las ramas de abajo para la causa real envuelta (puede ser un
    // Error nativo, un objeto plano de Supabase, o cualquier otra cosa) —
    // mismo diagnosticId, para que ambas líneas de log se correlacionen.
    logRenderError(context, error.stageError, diagnosticId);
    return;
  }
  if (error instanceof MissingEnvVarError) {
    console.error(`[render] ${context} [${diagnosticId}]: variable de entorno ausente`, {
      varName: error.varName,
    });
    return;
  }
  if (error instanceof Error) {
    console.error(`[render] ${context} [${diagnosticId}]: ${error.name}: ${error.message}`);
    return;
  }
  // Los errores de Supabase (p. ej. el `error` de un .update()) son objetos
  // planos { message, code }, no instancias de Error — sin esto caerían al
  // "error desconocido" de abajo y se perdería el detalle.
  if (error && typeof error === "object" && "message" in error) {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    console.error(`[render] ${context} [${diagnosticId}]: ${(error as { message: unknown }).message}`, {
      code,
    });
    return;
  }
  console.error(`[render] ${context} [${diagnosticId}]: error desconocido`, error);
}
