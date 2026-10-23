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
  return JSON.parse(fenced ? fenced[1] : t);
}

/** Punto ÚNICO de aceptación para todos los contratos de micro-llamadas (revisión, reparaciones de apertura,
 * funciones, anclas visuales, escenas y plan visual): R1 y luego el esquema completo, sin otra tolerancia. */
export function acceptContract<T extends z.ZodType>(schema: T, value: unknown) {
  const normalized = normalizeToContract(schema, value);
  if (normalized.actions.length) console.warn("[atomivid:documentary-format-normalized]", JSON.stringify(normalized.actions.slice(0, 12)));
  return schema.safeParse(normalized.value) as ReturnType<T["safeParse"]>;
}
