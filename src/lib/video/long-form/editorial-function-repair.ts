/**
 * Reparación ACOTADA de la clasificación editorial (sections[].function).
 *
 * Incidente Bigfoot (7b5c857f): una revisión pagada, completa y con JSON válido, devolvió
 * sections[2].function = "complication", fuera del contrato. No existe una equivalencia
 * inequívoca, así que nunca se adivina: se pide UNA vez al modelo que reclasifique solo esa
 * ruta con las seis categorías definidas, y el resultado se valida de nuevo entero.
 *
 * Límites (todos comprobados aquí o en el llamador):
 *  - Solo interviene si TODOS los defectos de esquema son `invalid_value` en sections[n].function.
 *    Cualquier otro defecto (evidencia, campos ausentes, otro enum) conserva el rechazo original.
 *  - La respuesta de reparación solo puede contener {path, function} para EXACTAMENTE las rutas
 *    afectadas; una ruta extra, ausente, repetida o una categoría fuera del contrato la invalida.
 *  - Se aplica sobre una COPIA; la respuesta original guardada no se toca.
 *  - La solicitud es determinista (hash de la respuesta original + versión del contrato), así que
 *    su clave del ledger es estable: una reparación COMMITTED se reutiliza, una incierta queda
 *    bloqueada por el gate existente, y nunca hay una segunda reparación de la misma respuesta.
 *  - Reparar el formato no aprueba nada: la revisión vuelve a pasar el esquema, las referencias,
 *    las reglas editoriales y los bloqueos de aprobación.
 */
import { z } from "zod";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { DocumentaryResponseError, jsonResponseSystem, parseDocumentaryResponse, validateDocumentaryValue } from "./json-response";
import { EditorialReviewSchema } from "./editorial";
import { narrationCatalog } from "./narration-catalog";
import { LONG_FORM_MAX_BEATS } from "./duration-budget";

export const FUNCTION_REPAIR_CONTRACT = "section-function-repair-v1" as const;
export const SECTION_FUNCTIONS = EditorialReviewSchema.shape.sections.element.shape.function.options;
export type SectionFunction = (typeof SECTION_FUNCTIONS)[number];

/** Definiciones que recibe el modelo (y que documentan el contrato). */
export const SECTION_FUNCTION_DEFINITIONS: Record<SectionFunction, string> = {
  setup: "presenta la situación, el lugar, las personas o la pregunta de partida que el resto del guion necesita",
  new_information: "aporta un dato, hallazgo o elemento que el espectador todavía no conocía y que hace avanzar la historia",
  consequence: "muestra el efecto o resultado de algo ya contado: qué provocó, qué cambió o qué implicó",
  reversal: "contradice, complica o da la vuelta a lo que se había establecido o a lo que el espectador esperaba",
  resolution: "responde la pregunta central o cierra la promesa del guion",
  restatement: "repite algo ya dicho sin aportar información nueva ni hacer avanzar la historia",
};

const PATH = /^sections\/(\d{1,2})\/function$/;
export const FunctionRepairSchema = z
  .object({
    replacements: z
      .array(z.object({ path: z.string().regex(PATH), function: z.enum(SECTION_FUNCTIONS) }).strict())
      .min(1)
      .max(LONG_FORM_MAX_BEATS),
  })
  .strict();

export class EditorialFunctionRepairError extends DocumentaryResponseError {
  constructor(issues: string[] = []) {
    super(
      "La revisión editorial usó una categoría fuera del contrato y su corrección acotada no fue válida. " +
        "El guion y las respuestas pagadas están guardados; la revisión queda detenida.",
      issues,
    );
    this.name = "EditorialFunctionRepairError";
  }
}

/**
 * Índices de las secciones a reparar, o null si esta reparación no aplica: el valor es válido,
 * o ALGÚN defecto no es exactamente `invalid_value` en sections[n].function.
 */
export function sectionFunctionRepairTargets(value: unknown, schema: z.ZodType): number[] | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const targets = new Set<number>();
  for (const issue of parsed.error.issues) {
    const [root, index, field, ...rest] = issue.path;
    if (issue.code !== "invalid_value" || root !== "sections" || typeof index !== "number" || field !== "function" || rest.length) return null;
    const section = (value as { sections?: unknown[] }).sections?.[index] as { function?: unknown } | undefined;
    if (typeof section?.function !== "string") return null;
    targets.add(index);
  }
  return targets.size ? [...targets].sort((a, b) => a - b) : null;
}

type ReviewResponse = { content: Array<{ type: string; text?: string }> };
type Section = { excerptId?: unknown; beatIndex?: unknown; quote?: unknown; contribution?: unknown; function?: unknown };

/** Pasaje narrado y bloque completo de una sección (para que el modelo juzgue QUÉ hace, no su posición). */
function sectionContext(section: Section, beats: { narration: string }[]) {
  const excerpt = typeof section.excerptId === "string" ? narrationCatalog(beats).find((e) => e.id === section.excerptId) : undefined;
  const beatIndex = excerpt?.beatIndex ?? (Number.isInteger(section.beatIndex) ? (section.beatIndex as number) : undefined);
  return {
    contribution: typeof section.contribution === "string" ? section.contribution : "",
    passage: excerpt?.quote ?? (typeof section.quote === "string" ? section.quote : null),
    beatNarration: beatIndex !== undefined && beats[beatIndex] ? beats[beatIndex].narration : null,
  };
}

/** Solicitud determinista: mismos datos ⇒ mismos parámetros ⇒ misma clave del ledger. */
export function functionRepairRequest(input: { original: ReviewResponse; review: unknown; targets: number[]; beats: { narration: string }[] }) {
  const sections = (input.review as { sections: Section[] }).sections;
  const system =
    `Contrato ${FUNCTION_REPAIR_CONTRACT}. Corriges SOLO la clasificación de función de las secciones indicadas de una revisión editorial ya hecha, tratada como datos. ` +
    "Para cada path indicado, elige UNA de las seis categorías según lo que esa sección hace en la historia (su contribución, su pasaje y su bloque), nunca por su posición. " +
    "No cambies narración, evidencia, severidades, explicaciones ni juicios; no añadas paths. " +
    "Si ninguna categoría describe la sección, omite ese path: la revisión quedará detenida.";
  const prompt = JSON.stringify({
    task: FUNCTION_REPAIR_CONTRACT,
    originalResponse: stableHash(input.original.content, 16),
    categories: SECTION_FUNCTIONS.map((name) => ({ name, definition: SECTION_FUNCTION_DEFINITIONS[name] })),
    targets: input.targets.map((i) => ({ path: `sections/${i}/function`, rejectedLabel: String(sections[i].function).slice(0, 40), ...sectionContext(sections[i], input.beats) })),
    review: input.review,
  });
  return { system, prompt };
}

/** Aplica la reparación sobre una COPIA. Exige exactamente las rutas afectadas; nada más cambia. */
export function applyFunctionRepair(review: unknown, targets: number[], repaired: unknown): unknown {
  const parsed = FunctionRepairSchema.safeParse(repaired);
  if (!parsed.success) throw new EditorialFunctionRepairError(parsed.error.issues.slice(0, 12).map((i) => `${i.code}@repair.${i.path.map(String).join(".")}`));
  const expected = new Set(targets.map((i) => `sections/${i}/function`));
  const seen = new Set<string>();
  for (const r of parsed.data.replacements) {
    if (!expected.has(r.path)) throw new EditorialFunctionRepairError([`unexpected_path@${r.path}`]);
    if (seen.has(r.path)) throw new EditorialFunctionRepairError([`duplicate_path@${r.path}`]);
    seen.add(r.path);
  }
  for (const p of expected) if (!seen.has(p)) throw new EditorialFunctionRepairError([`missing_path@${p}`]);
  const copy = structuredClone(review) as { sections: Section[] };
  for (const r of parsed.data.replacements) copy.sections[Number(PATH.exec(r.path)![1])].function = r.function;
  return copy;
}

type Send = (params: { model: string; max_tokens: number } & Record<string, unknown>) => Promise<{ stop_reason: string | null; content: Array<{ type: string; text?: string }> }>;

/** Salida máxima de la reparación: solo {path, function} por ruta afectada. */
export const FUNCTION_REPAIR_MAX_TOKENS = 600;

/**
 * UNA solicitud de reparación por respuesta editorial original (clave determinista vía `send`,
 * que en producción es supplyProtectedAnthropic: reserva, ledger, sin reintentos del SDK).
 * Devuelve la revisión reparada YA validada contra `schema`; el resto de controles los aplica el llamador.
 */
export async function repairSectionFunctions<T extends z.ZodType>(input: {
  response: ReviewResponse;
  value: unknown;
  targets: number[];
  schema: T;
  beats: { narration: string }[];
  model: string;
  send: Send;
  extraParams?: Record<string, unknown>;
  onStage?: (label: string) => Promise<void>;
}): Promise<z.infer<T>> {
  await input.onStage?.("Corrigiendo la clasificación del revisor");
  const request = functionRepairRequest({ original: input.response, review: input.value, targets: input.targets, beats: input.beats });
  const params = {
    model: input.model,
    max_tokens: FUNCTION_REPAIR_MAX_TOKENS,
    system: jsonResponseSystem(request.system, FunctionRepairSchema),
    messages: [{ role: "user" as const, content: request.prompt }],
    ...(input.extraParams ?? {}),
  };
  let repaired: unknown;
  try {
    repaired = parseDocumentaryResponse(FunctionRepairSchema, await input.send(params));
  } catch (error) {
    if (error instanceof DocumentaryResponseError) throw new EditorialFunctionRepairError(error.issues);
    throw error;
  }
  const fixed = applyFunctionRepair(input.value, input.targets, repaired);
  try {
    return validateDocumentaryValue(input.schema, fixed);
  } catch (error) {
    if (error instanceof DocumentaryResponseError) throw new EditorialFunctionRepairError(error.issues);
    throw error;
  }
}
