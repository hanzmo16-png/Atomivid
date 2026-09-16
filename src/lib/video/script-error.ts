import { MissingEnvVarError } from "@/lib/env-errors";

/**
 * Mensaje seguro para el cliente — nunca el mensaje crudo del proveedor de
 * guion (podría nombrar el proveedor o detalles internos, algo que este
 * proyecto evita deliberadamente exponer al usuario en otras pantallas).
 * Para variable de entorno ausente sí se incluye su nombre exacto, que no
 * es secreto y es justo lo que hay que corregir.
 */
export function classifyScriptError(error: unknown): string {
  if (error instanceof MissingEnvVarError) {
    return `Falta configurar ${error.varName} en el servidor. Contacta al soporte.`;
  }
  return "No se pudo generar el guion en este momento. Intenta de nuevo.";
}

/** Log de servidor seguro: solo nombre/tipo del error, nunca su mensaje crudo. */
export function logScriptError(context: string, error: unknown): void {
  if (error instanceof MissingEnvVarError) {
    console.error(`[script] ${context}: variable de entorno ausente`, {
      varName: error.varName,
    });
    return;
  }
  if (error instanceof Error) {
    console.error(`[script] ${context}: ${error.name}`);
    return;
  }
  console.error(`[script] ${context}: error desconocido`);
}
