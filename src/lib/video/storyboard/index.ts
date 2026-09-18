import { requireRealProvider } from "@/lib/providers/production";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { generateStoryboard as generateStoryboardReal } from "./visual-director";
import { simulateStoryboard } from "./simulate";
import type { Storyboard } from "./types";

export type StoryboardSource = "claude" | "simulated";

/**
 * Punto único de entrada al Visual Director. Respeta VISUAL_DIRECTOR_ENABLED
 * (ver feature-flags.ts): si está apagado o falta ANTHROPIC_API_KEY, cae a
 * la construcción determinista sin red (`simulate.ts`) en vez de fallar —
 * el storyboard nunca es un bloqueante duro del pipeline actual.
 */
export async function buildStoryboard(
  script: GeneratedScript,
  language: ScriptLanguage = "es",
): Promise<{ storyboard: Storyboard; source: StoryboardSource }> {
  const flags = getFeatureFlags();
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

  if (flags.visualDirectorEnabled && hasKey) {
    const storyboard = await generateStoryboardReal(script, language);
    return { storyboard, source: "claude" };
  }

  requireRealProvider("storyboard", false);
  return { storyboard: simulateStoryboard(script), source: "simulated" };
}

export * from "./types";
export { generateStoryboard as generateStoryboardWithClaude, StoryboardGenerationError } from "./visual-director";
export { simulateStoryboard } from "./simulate";
