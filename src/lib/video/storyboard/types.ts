/**
 * Contrato del "Visual Director": convierte un guion completo (no
 * oraciones sueltas) en un storyboard estructurado y validable, con
 * intención, prompts y fallbacks por escena — la capa intermedia entre
 * "qué dice la narración" y "qué se busca/genera/descarga" que hoy NO
 * existe (footage-select.ts recibe directamente visualQuery/visualConcepts
 * del guion, sin pasar por un análisis narrativo del conjunto).
 *
 * Zod es la única fuente de verdad: el mismo schema valida en runtime Y se
 * usa como `output_config.format` en la llamada a Claude (igual patrón que
 * src/lib/ai/script.ts), así que un guion de Claude que no cumpla el
 * contrato nunca llega más allá de este módulo.
 */
import { z } from "zod";

export const SceneEnergySchema = z.enum(["low", "medium", "high"]);

export const ResourceTypeSchema = z.enum([
  "stock_video",
  "generated_image",
  "generated_video",
  "motion_graphic",
  "abstract",
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const FallbackStepSchema = z.enum([
  "retry_prompt",
  "alternate_provider",
  "validated_stock",
  "motion_graphic",
]);
export type FallbackStep = z.infer<typeof FallbackStepSchema>;

export const StoryboardSceneSchema = z.object({
  id: z.string().describe("Identificador estable de la escena, p. ej. 'scene-0'."),
  order: z.number().int().min(0).describe("Orden de aparición, empezando en 0."),
  narrationText: z.string().describe("Texto EXACTO de narración que cubre esta escena (subconjunto literal del guion, sin parafrasear)."),
  estimatedDurationSeconds: z
    .number()
    .positive()
    .describe("Duración estimada antes de conocer el timing real de la voz — se reemplaza por el timing real alineado a palabras una vez sintetizada la narración."),
  literalMeaning: z.string().describe("Qué dice literalmente esta frase."),
  emotionalSubtext: z.string().describe("Qué siente o insinúa el hablante más allá de lo literal (subtexto emocional)."),
  narrativeGoal: z.string().describe("Qué debe lograr esta escena en el arco del video (enganchar, generar tensión, resolver, etc.)."),
  dominantEmotion: z.string().describe("Emoción dominante a transmitir, en una o dos palabras (p. ej. 'cansancio esperanzado')."),
  energy: SceneEnergySchema,
  subject: z.string().describe("Sujeto principal visible en el plano (p. ej. 'a tired person in their 20s')."),
  visibleAction: z
    .string()
    .describe(
      "Acción humana VISIBLE que comunica la idea sin depender de metáforas confusas. Ejemplo: para " +
        "'la motivación desaparece cuando más la necesitas', NO uses 'persona inconsciente tirada en la calle' " +
        "(mala interpretación, sugiere desmayo/violencia) — usa 'a tired person sitting on the edge of a bed " +
        "before dawn, deciding to put on their shoes and get up anyway'.",
    ),
  environment: z.string().describe("Entorno/locación (p. ej. 'bedroom', 'urban street at dawn')."),
  timeOfDay: z.string().describe("Momento del día (p. ej. 'before dawn', 'midday', 'golden hour')."),
  shotType: z.string().describe("Tipo de plano (p. ej. 'medium close-up', 'wide establishing shot')."),
  cameraMovement: z.string().describe("Movimiento de cámara recomendado (p. ej. 'slow push-in', 'static locked-off')."),
  lighting: z.string().describe("Iluminación (p. ej. 'soft blue pre-dawn light through a window')."),
  colorPalette: z.string().describe("Paleta cromática (p. ej. 'desaturated cool blues with one warm accent')."),
  visualStyle: z.string().describe("Estilo visual (p. ej. 'cinematic, shallow depth of field, realistic, not stylized')."),
  imagePrompt: z.string().describe("Prompt detallado en inglés para un generador de imágenes/video, autocontenido (no asume contexto de otras escenas salvo lo dicho en continuityWithPrevious)."),
  negativePrompt: z.string().describe("Elementos en inglés que deben evitarse (p. ej. 'text overlay, watermark, unconscious person, violence, medical imagery, deformed hands')."),
  stockQueries: z
    .array(z.string())
    .min(2)
    .max(4)
    .describe("2-4 consultas alternativas para stock (Pexels/Pixabay), cada una concepto+acción+ambiente, NUNCA la frase del guion tal cual."),
  resourceType: ResourceTypeSchema.describe("Tipo de recurso recomendado para esta escena."),
  priority: z.number().int().min(1).max(5).describe("1 = máxima prioridad creativa (p. ej. el gancho inicial), 5 = mínima."),
  confidence: z.number().min(0).max(1).describe("Confianza del Visual Director en que esta interpretación es la correcta (0-1)."),
  selectionRationale: z.string().describe("Por qué esta imagen/acción comunica la idea mejor que alternativas obvias (y qué alternativa mala se descartó, si aplica)."),
  continuityWithPrevious: z.string().describe("Qué debe mantenerse igual respecto a la escena anterior (personaje, vestuario, locación, paleta) — 'none' si es la primera escena o no aplica."),
  continuityWithNext: z.string().describe("Qué debe preparar o anticipar para la escena siguiente — 'none' si es la última."),
  maxCostUsd: z.number().min(0).describe("Costo máximo permitido para el recurso de esta escena, en USD."),
  fallbackStrategy: z
    .array(FallbackStepSchema)
    .min(1)
    .describe("Orden de fallback si el recurso preferido falla o no alcanza el umbral de calidad: reintentar prompt corregido → proveedor alternativo → stock validado → motion graphic. Nunca vacío — motion_graphic es el último recurso garantizado."),
});
export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export const VisualIdentitySchema = z.object({
  characterAgeAndAppearance: z.string().describe("Edad aproximada y apariencia de personajes recurrentes — 'no recurring characters' si no aplica."),
  wardrobe: z.string().describe("Vestuario consistente, si hay personajes recurrentes."),
  place: z.string().describe("Lugar/ambiente general del video."),
  colorPalette: z.string().describe("Paleta cromática global que todas las escenas deben respetar."),
  lighting: z.string().describe("Estilo de iluminación general."),
  realismLevel: z.string().describe("Nivel de realismo (p. ej. 'photorealistic cinematic', 'not stylized or illustrated')."),
  aspectRatio: z.literal("9:16"),
  emotionalTone: z.string().describe("Tono emocional general del video."),
  narrativeArc: z.string().describe("Arco narrativo de principio a fin en una frase."),
});
export type VisualIdentity = z.infer<typeof VisualIdentitySchema>;

export const StoryboardSchema = z.object({
  visualIdentity: VisualIdentitySchema,
  hookDescription: z.string().describe("Qué debe mostrar el primer plano (0-2s) para detener el scroll — la escena 0 debe reflejar esto."),
  closingDescription: z.string().describe("Cómo debe sentirse/verse el cierre — la última escena debe reflejar esto, con un concepto visual no usado antes."),
  scenes: z.array(StoryboardSceneSchema).min(1),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** Resultado normalizado de validar un storyboard crudo (de Claude o de un fixture) contra el schema. */
export type StoryboardValidationResult =
  | { valid: true; storyboard: Storyboard }
  | { valid: false; errors: string[] };

export function validateStoryboard(raw: unknown): StoryboardValidationResult {
  const result = StoryboardSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, storyboard: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}
