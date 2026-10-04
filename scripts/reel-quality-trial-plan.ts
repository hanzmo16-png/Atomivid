/** Frozen render-stage test, not a new customer feature or an automatic script-generation test. */
import type { GeneratedScript } from "../src/lib/providers/types";
import { VisualIntentSchema } from "../src/lib/video/visual-intent";
import { stableHash } from "../src/lib/production-intelligence/canonical";

export const REQUEST = "40b04013-986f-4621-bfc2-4cf0f265287d";
export const OWNER = "d2064950-7a95-4208-8dfb-d93b470d141d";
export const KEY = "reel_quality_trial_authorization_20261004_2030";
export const IDEMPOTENCY = "reel_quality_trial_20261004_2030";
export const LABELS = ["Gris", "Reptiliano", "Arcturiano", "Pleyadiano", "Urmah"];
const definitions = [
  ["En la ficción extraterrestre, los grises tienen piel gris, cabeza grande y ojos negros almendrados.", "grey humanoid alien", ["grey skin", "large bald head", "large black almond-shaped eyes"], ["lamp", "light bulb", "stars without an alien"], "Fictional slender grey humanoid alien, large bald head and enormous black almond-shaped eyes, atmospheric science-fiction set."],
  ["Los reptilianos se representan como humanoides de escamas verdes y pupilas verticales.", "reptilian humanoid alien", ["humanoid torso and arms", "green reptilian scales", "eyes with vertical slit pupils"], ["ordinary iguana", "ordinary lizard", "four-legged reptile"], "Fictional upright reptilian humanoid, humanlike torso and arms, green scales, ridged brow, amber eyes with vertical slit pupils, subtle science-fiction armor."],
  ["Los arcturianos suelen ilustrarse con piel azul, cabeza alargada y ojos luminosos.", "blue Arcturian humanoid alien", ["blue-skinned humanoid", "elongated bald head", "luminous eyes"], ["grey-skinned alien", "astronaut helmet", "space without a figure"], "Fictional slender blue-skinned Arcturian humanoid, elongated bald head, luminous blue eyes, thoughtful expression, elegant silver robes."],
  ["Los pleyadianos aparecen con aspecto humano, cabello rubio largo y vestimenta futurista.", "Pleiadian humanlike alien character", ["humanlike adult", "long golden-blond hair", "futuristic silver clothing"], ["stars without a figure", "short dark hair", "grey alien"], "Fictional Pleiadian adult, natural humanlike facial proportions, long golden-blond hair, blue eyes, futuristic silver clothing, softly illuminated science-fiction setting."],
  ["Los Urmah combinan cuerpo humanoide, rostro felino y melena dorada. Son representaciones artísticas, no fotografías de seres comprobados.", "Urmah feline humanoid alien", ["humanoid torso and arms", "lionlike feline head and muzzle", "golden mane"], ["ordinary four-legged lion", "ordinary cat", "human head"], "Fictional proud Urmah, muscular upright humanoid torso and two arms, lionlike head and muzzle, golden mane, amber eyes, ceremonial science-fiction clothing."],
] as const;
export const SCRIPT: GeneratedScript = {
  title: "Cinco seres extraterrestres en la ficción",
  segments: definitions.map(([text, subject, mustShow, mustNotShow, description], index) => ({
    text, visualQuery: subject, visualConcepts: [subject], energy: index === 0 ? "high" : "medium",
    emphasisWords: [LABELS[index]],
    visualIntent: VisualIntentSchema.parse({ source: "illustration", subject, mustShow: [...mustShow], mustNotShow: [...mustNotShow],
      imagePrompt: "Cinematic high-quality fictional character portrait, vertical 9:16 safe composition. Show the defining features, head, torso and arms clearly within the central safe area, with space around the character. Coherent anatomy, sharp detail, deliberate lighting. No text, logos or watermark. " + description }),
  })),
};
export const LIMITS = { version: "reel-quality-trial/1", ownerId: OWNER, requestId: REQUEST, maxImages: 5, maxReviews: 20,
  maxAccountedUsd: 0.65, maxVoiceCalls: 2, maxVoiceCharacters: 650, voiceId: "uYlzyj2kIZo3HfBB21vF", modelId: "eleven_multilingual_v2",
  maxImageReservationUsd: 0.08, voiceEstimatedUsdPer1kChars: 0.1, durationSeconds: 30, reviewPolicy: "literal-visual-quality/2" } as const;
export const PLAN_HASH = stableHash({ script: SCRIPT, limits: LIMITS }, 64);
if (process.argv.includes("--check")) console.log(JSON.stringify({ script: SCRIPT, limits: LIMITS, planHash: PLAN_HASH,
  voiceCharacters: SCRIPT.segments.map(s => s.text).join(" ").length, words: SCRIPT.segments.map(s => s.text).join(" ").split(/\s+/).length, paidCalls: 0 }));
