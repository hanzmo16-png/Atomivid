/**
 * Sanitización LIMITADA de residuos de formato conocidos en el texto que
 * devuelve Claude — observado en producción: el campo
 * `visualIdentity.narrativeArc` de una respuesta real (run 35240163644,
 * stop_reason="end_turn", JSON válido, sin truncamiento) terminó con un
 * marcador `<END>` pegado a la última frase.
 *
 * Deliberadamente NO es una limpieza general: solo elimina marcadores
 * conocidos exactamente al inicio o final de un string, nunca en medio del
 * texto, y nunca cambia el contenido semántico. Se aplica DESPUÉS de
 * JSON.parse (JSON ya válido) y ANTES de la validación con Zod — nunca
 * antes: un JSON inválido o una respuesta truncada deben seguir fallando
 * exactamente igual que antes (ver visual-director.ts, que revisa
 * stop_reason ANTES de intentar JSON.parse) — esto no oculta ninguno de
 * esos dos casos, solo limpia un residuo cosmético de una respuesta que ya
 * era válida.
 */

// Cada patrón se ancla al inicio (^) o final ($) del string, con espacio
// opcional alrededor — nunca coincide con el marcador en medio del texto.
const RESIDUAL_MARKER_PATTERNS: RegExp[] = [
  /^\s*<END>\s*/i,
  /\s*<END>\s*$/i,
  /^\s*\[END\]\s*/i,
  /\s*\[END\]\s*$/i,
  /^\s*<STOP>\s*/i,
  /\s*<STOP>\s*$/i,
];

export function sanitizeResidualMarkers(text: string): string {
  let result = text;
  for (const pattern of RESIDUAL_MARKER_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result;
}

/**
 * Recorre recursivamente un valor JSON ya parseado (objeto/array/string
 * plano) y aplica `sanitizeResidualMarkers` a cada string — no toca
 * números, booleanos, null ni las claves de los objetos.
 */
export function sanitizeStoryboardStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeResidualMarkers(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeStoryboardStrings);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeStoryboardStrings(val);
    }
    return result;
  }
  return value;
}
