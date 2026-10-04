import { z } from "zod";
import type { GeneratedScript, ScriptScene } from "@/lib/providers/types";

/** A subject contract, rather than a bag of loosely related search terms. */
export const VisualIntentSchema = z.object({
  source: z.enum(["stock", "illustration"]),
  subject: z.string().min(3).max(240),
  mustShow: z.array(z.string().min(2).max(160)).min(1).max(5),
  mustNotShow: z.array(z.string().min(2).max(120)).max(8),
  imagePrompt: z.string().min(20).max(1400),
}).strict();
export type VisualIntent = z.infer<typeof VisualIntentSchema>;

export const VISUAL_INTENT_INSTRUCTIONS = `Define visualIntent for EVERY scene in English: source (stock or illustration), subject (the actual visible subject), mustShow (1-5 visible defining traits/actions), mustNotShow (wrong substitutes), imagePrompt (a self-contained image description). Preserve named subjects and distinctive traits in ALL visualQuery/visualConcepts alternatives; vary camera, action or environment, never the subject. A reptilian alien is a humanoid alien with reptilian traits, not an iguana; a grey alien is an alien figure, not a lamp, an eye close-up or stars. Apply this rule to every topic: a named animal, historical reconstruction, product, dish, person or fictional creature must be represented faithfully. Choose illustration for fictional beings, historical reconstructions or scenes unavailable as ordinary stock. Never present an invented image as a real historical photograph or proof. For motivational/abstract narration choose a concrete relevant action IN THE SAME DOMAIN. Measuring customers, sales and service costs means business sales/customer reports, not cryptocurrency or stock-market trading screens; explicitly exclude candlestick trading charts and trading platforms for such scenes. Preserve this domain in search alternatives and fallback prompts. For descriptive narration show the described subject. Do not replace a missing subject with generic scenery or a metaphor.`;

export function requireVisualIntents(segments: ScriptScene[]): VisualIntent[] {
  return segments.map((segment, index) => {
    const parsed = VisualIntentSchema.safeParse(segment.visualIntent);
    if (!parsed.success) throw new Error(`La escena ${index + 1} necesita un plan visual actualizado. Regenera su guion antes de producir el video.`);
    return parsed.data;
  });
}

export function visualPlanIssue(segments: ScriptScene[]): string | null {
  const index = segments.findIndex(segment => !VisualIntentSchema.safeParse(segment.visualIntent).success);
  return index < 0 ? null : `La escena ${index + 1} necesita un plan visual actualizado. Regenera esa escena antes de generar el video.`;
}

/** Manual edits may retain only the server's plan for unchanged narration/searches. */
export function preserveUnchangedVisualPlans(script: GeneratedScript, previous: GeneratedScript | null): GeneratedScript {
  return { ...script, segments: script.segments.map((segment, index) => {
    const prior = previous?.segments[index];
    const unchanged = prior && segment.text === prior.text && segment.visualQuery === prior.visualQuery
      && JSON.stringify(segment.visualConcepts ?? []) === JSON.stringify(prior.visualConcepts ?? []);
    return { ...segment, visualIntent: unchanged ? prior.visualIntent : undefined };
  }) };
}

export const VisualVerdictSchema = z.object({
  subjectPresent: z.boolean(),
  allRequiredTraitsPresent: z.boolean(),
  forbiddenSubstitutePresent: z.boolean(),
  unrelatedTextOrWatermark: z.boolean(),
  subjectClear: z.boolean(),
  compositionAcceptable: z.boolean(),
  visualArtifactsPresent: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(360),
}).strict();
export type VisualVerdict = z.infer<typeof VisualVerdictSchema>;
export function acceptsVisual(verdict: unknown): boolean {
  const parsed = VisualVerdictSchema.safeParse(verdict);
  return parsed.success && parsed.data.subjectPresent && parsed.data.allRequiredTraitsPresent
    && !parsed.data.forbiddenSubstitutePresent && !parsed.data.unrelatedTextOrWatermark
    && parsed.data.subjectClear && parsed.data.compositionAcceptable && !parsed.data.visualArtifactsPresent
    && parsed.data.confidence >= 0.8;
}
