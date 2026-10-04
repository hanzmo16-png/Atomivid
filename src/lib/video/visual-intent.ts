import { z } from "zod";
import type { ScriptScene } from "@/lib/providers/types";

/** A subject contract, rather than a bag of loosely related search terms. */
export const VisualIntentSchema = z.object({
  source: z.enum(["stock", "illustration"]),
  subject: z.string().min(3).max(240),
  mustShow: z.array(z.string().min(2).max(160)).min(1).max(5),
  mustNotShow: z.array(z.string().min(2).max(120)).max(8),
  imagePrompt: z.string().min(20).max(1400),
}).strict();
export type VisualIntent = z.infer<typeof VisualIntentSchema>;

export const VISUAL_INTENT_INSTRUCTIONS = `Define visualIntent for EVERY scene in English: source (stock or illustration), subject (the actual visible subject), mustShow (1-5 visible defining traits/actions), mustNotShow (wrong substitutes), imagePrompt (a self-contained image description). Preserve named subjects and distinctive traits in ALL visualQuery/visualConcepts alternatives; vary camera, action or environment, never the subject. A reptilian alien is a humanoid alien with reptilian traits, not an iguana; a grey alien is an alien figure, not a lamp, an eye close-up or stars. Apply this rule to every topic: a named animal, historical reconstruction, product, dish, person or fictional creature must be represented faithfully. Choose illustration for fictional beings, historical reconstructions or scenes unavailable as ordinary stock. Never present an invented image as a real historical photograph or proof. For motivational/abstract narration choose a concrete relevant action; for descriptive narration show the described subject. Do not replace a missing subject with generic scenery or a metaphor.`;

export function requireVisualIntents(segments: ScriptScene[]): VisualIntent[] {
  return segments.map((segment, index) => {
    const parsed = VisualIntentSchema.safeParse(segment.visualIntent);
    if (!parsed.success) throw new Error(`La escena ${index + 1} necesita un plan visual actualizado. Regenera su guion antes de producir el video.`);
    return parsed.data;
  });
}

export const VisualVerdictSchema = z.object({
  subjectPresent: z.boolean(),
  allRequiredTraitsPresent: z.boolean(),
  forbiddenSubstitutePresent: z.boolean(),
  unrelatedTextOrWatermark: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(360),
}).strict();
export type VisualVerdict = z.infer<typeof VisualVerdictSchema>;
export function acceptsVisual(verdict: unknown): boolean {
  const parsed = VisualVerdictSchema.safeParse(verdict);
  return parsed.success && parsed.data.subjectPresent && parsed.data.allRequiredTraitsPresent
    && !parsed.data.forbiddenSubstitutePresent && !parsed.data.unrelatedTextOrWatermark && parsed.data.confidence >= 0.8;
}
