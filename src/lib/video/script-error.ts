import { MissingEnvVarError } from "@/lib/env-errors";
import { ScriptQualityError } from "@/lib/video/script-quality";

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
 */
export function classifyScriptError(error: unknown): string {
  if (error instanceof MissingEnvVarError) {
    return `Falta configurar ${error.varName} en el servidor. Contacta al soporte.`;
  }
  if (error instanceof ScriptQualityError) {
    if (error.result.issue === "fallback_provider") {
      return "No se pudo generar el guion con el proveedor de IA principal — se usó contenido de respaldo, que no es apto para publicar. Vuelve a intentarlo en unos minutos.";
    }
    return "El guion generado no cumplió los estándares de calidad (repetición o contenido genérico). Pulsa reintentar — cada intento genera contenido distinto.";
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
  if (error instanceof ScriptQualityError) {
    console.error(`[script] ${context}: guion rechazado por calidad`, {
      issue: error.result.issue,
    });
    return;
  }
  if (error instanceof Error) {
    console.error(`[script] ${context}: ${error.name}`);
    return;
  }
  console.error(`[script] ${context}: error desconocido`);
}
