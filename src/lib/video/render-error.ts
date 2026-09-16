import { randomUUID } from "node:crypto";
import { MissingEnvVarError } from "@/lib/env-errors";

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

export function classifyRenderError(error: unknown, diagnosticId: string): string {
  if (error instanceof MissingEnvVarError) {
    return `Falta configurar ${error.varName} en el servidor. Contacta al soporte. (Código: ${diagnosticId})`;
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
