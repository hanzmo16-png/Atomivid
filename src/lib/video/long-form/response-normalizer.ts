/**
 * Capa B — normalización técnica tolerante (Operación rescate del motor editorial, 2026-10-23).
 *
 * Los contratos JSON de Long Form son SOLO de prompt (sin gramática del proveedor), así que el modelo
 * produce ruido de forma inevitable. Antes, cada micro-llamada validaba con `.strict()` y cualquier
 * diferencia de forma se convertía en un fallo terminal "La respuesta no cumple el formato editorial
 * requerido", aunque el contenido fuera correcto y estuviera pagado (incidentes 23d86d0a / 8c330c37).
 *
 * Esta capa separa FORMA de CONTENIDO con un conjunto CERRADO de reglas sin pérdida de significado:
 *  R1 `empty_unknown_key`: clave no reconocida por el esquema con valor null o texto en blanco.
 *  (R2 genérico RETIRADO tras las auditorías de Claude A2 y ChatGPT P0: descartar primitivas desconocidas
 *   con contenido podía borrar un veredicto más estricto, p. ej. `evidence.delivered:false`. Los ecos de
 *   cita/índice solo se aceptan por contrato y verificados contra el catálogo: ver editorial-opening-repair.ts.)
 * Todo lo demás sigue fallando igual: campos ausentes o mal tipados, enums fuera de contrato, valores
 * fuera de rango, claves desconocidas con contenido fuera de una evidencia, objetos/arrays extra.
 * El valor de entrada nunca se muta: la respuesta pagada guardada sigue byte-idéntica para auditoría.
 */
import { z } from "zod";

export type NormalizationRule = "empty_unknown_key";
export type NormalizationAction = { rule: NormalizationRule; path: string };
export type Normalized = { value: unknown; actions: NormalizationAction[] };

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function objectAt(root: unknown, path: readonly PropertyKey[]): Record<string, unknown> | null {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node !== null && typeof node === "object" && !Array.isArray(node) ? node as Record<string, unknown> : null;
}

/** Aplica R1 solo donde el propio esquema reporta `unrecognized_keys`. Determinista e idempotente. */
export function normalizeToContract<T extends z.ZodType>(schema: T, value: unknown): Normalized {
  let current = value;
  const actions: NormalizationAction[] = [];
  for (let round = 0; round < 8; round++) {
    const parsed = schema.safeParse(current);
    if (parsed.success) break;
    let changed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      if (current === value) current = structuredClone(value);
      const target = objectAt(current, issue.path);
      if (!target) continue;
      for (const key of (issue as { keys: string[] }).keys) {
        if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
        const rule: NormalizationRule | null = isBlank(target[key]) ? "empty_unknown_key" : null;
        if (!rule) continue;
        delete target[key];
        actions.push({ rule, path: issue.path.map(String).join(".") });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { value: current, actions };
}

/** Texto -> documento JSON. Acepta solo envolturas sin contenido: BOM, espacios y UNA valla ``` (con o
 * sin etiqueta json, con o sin salto de línea). Nunca extrae JSON de prosa ni rescata objetos parciales. */
export function extractJsonDocument(text: string): unknown {
  const t = text.replace(/^\uFEFF/, "").trim();
  const fenced = t.match(/^```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/);
  const doc = fenced ? fenced[1] : t;
  try { return JSON.parse(doc); }
  catch (error) {
    const repaired = repairJsonSyntax(doc);
    if (!repaired.rules.length) throw error;
    const value = JSON.parse(repaired.text); // still invalid → the original rejection stands (caller maps it)
    // Audit of PR #199: `{"supported":false,supported:true}` must not become valid JSON whose last key silently
    // wins. A repaired document with a duplicate key in the same object is refused with the original error.
    const dup = duplicateJsonKey(repaired.text);
    if (dup) { console.warn("[atomivid:documentary-format-refused]", JSON.stringify({ rules: repaired.rules, duplicateKey: dup })); throw error; }
    console.warn("[atomivid:documentary-format-normalized]", JSON.stringify(repaired.rules));
    return value;
  }
}

/**
 * Incident 12045fcd (2026-10-23, job e8048599, visual plan of block 7): a complete answer (end_turn) carried one
 * object key without quotes — `…,"place":"",era:"",…` — and the whole paid plan was unreadable. Two lossless,
 * syntax-only repairs, applied by a string-aware scan and ONLY when the document does not parse as is:
 *  - `unquoted_key`: an identifier in KEY position (right after `{` or `,`, immediately followed by `:`) is quoted;
 *  - `trailing_comma`: a comma directly before `}` or `]` is removed.
 * Nothing inside strings is touched, no value is invented, prose around a document is still refused, and a
 * document that remains invalid after these two repairs keeps the original error. The stored response is unchanged.
 */
/** First key that appears twice in the same object of a (valid) JSON text, or null. String-aware scan. */
export function duplicateJsonKey(text: string): string | null {
  const stack: (Set<string> | null)[] = [];   // a Set per open object, null per open array
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      let j = i + 1;
      for (; j < text.length; j++) { if (text[j] === "\\") j++; else if (text[j] === '"') break; }
      let k = j + 1; while (k < text.length && /\s/.test(text[k])) k++;
      const keys = stack[stack.length - 1];
      if (text[k] === ":" && keys) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
      }
      i = j;
    }
  }
  return null;
}

export function repairJsonSyntax(src: string): { text: string; rules: string[] } {
  let out = "", inString = false, escaped = false, quoted = 0, commas = 0;
  const lastSignificant = () => { for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k]; return ""; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ",") {
      let k = i + 1; while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === "}" || src[k] === "]") { commas++; continue; }
      out += c; continue;
    }
    if (/[A-Za-z_$]/.test(c) && (lastSignificant() === "{" || lastSignificant() === ",")) {
      let k = i; while (k < src.length && /[\w$]/.test(src[k])) k++;
      let m = k; while (m < src.length && /\s/.test(src[m])) m++;
      if (src[m] === ":") { out += `"${src.slice(i, k)}"`; quoted++; i = k - 1; continue; }
    }
    out += c;
  }
  return { text: out, rules: [...(quoted ? [`unquoted_key*${quoted}`] : []), ...(commas ? [`trailing_comma*${commas}`] : [])] };
}

/** Punto ÚNICO de aceptación para todos los contratos de micro-llamadas (revisión, reparaciones de apertura,
 * funciones, anclas visuales, escenas y plan visual): R1 y luego el esquema completo, sin otra tolerancia. */
export function acceptContract<T extends z.ZodType>(schema: T, value: unknown): z.ZodSafeParseResult<z.output<T>> {
  const normalized = normalizeToContract(schema, value);
  if (normalized.actions.length) console.warn("[atomivid:documentary-format-normalized]", JSON.stringify(normalized.actions.slice(0, 12)));
  return schema.safeParse(normalized.value) as z.ZodSafeParseResult<z.output<T>>;
}
