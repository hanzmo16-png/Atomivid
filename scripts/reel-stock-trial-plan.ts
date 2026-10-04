/** Frozen approved-script render test of the real stock selector, not automatic planning. */
import type { GeneratedScript } from "../src/lib/providers/types";
import { VisualIntentSchema } from "../src/lib/video/visual-intent";
import { stableHash } from "../src/lib/production-intelligence/canonical";
export const REQUEST = "9f0c276e-2cc2-440e-9f8c-3fbdd047974a";
export const OWNER = "d2064950-7a95-4208-8dfb-d93b470d141d";
export const KEY = "reel_stock_trial_authorization_20261004_2115";
export const IDEMPOTENCY = "reel_stock_trial_20261004_2115";
export const LABELS = ["Planear", "Validar", "Lanzar", "Medir"];
const definitions = [
  ["¿Tienes una idea de negocio? Antes de invertir más, toma tres decisiones que te permitan avanzar con claridad.", "person writing a business plan in a notebook", ["person writing notebook desk", "entrepreneur writing business plan"], ["person working at a desk", "open notebook and a hand actively writing on paper"], ["keyboard without a notebook", "empty desk", "unrelated food"], "An entrepreneur at a desk actively writing a business plan in an open notebook, writing hand and paper clearly visible, thoughtful professional setting."],
  ["Primero, valida el problema: habla con posibles clientes, escucha qué necesitan y observa cómo lo resuelven hoy.", "people discussing customer needs in a business meeting", ["customer interview meeting", "business meeting discussion"], ["two or more people in face-to-face discussion", "business or working setting"], ["empty office", "single person alone", "social party"], "Two professionals facing each other in a focused customer interview at a business table, listening and discussing needs, natural expressions and coherent hands."],
  ["Segundo, lanza una versión sencilla. Ofrece algo concreto que puedas entregar bien y aprende con las primeras ventas.", "small business worker packing product orders", ["small business packing orders", "person packing shipping boxes"], ["person handling or packing products for orders", "products or a shipping box clearly visible"], ["empty warehouse", "generic laptop with no products", "truck without a worker packing"], "Small-business owner carefully packing product orders into shipping boxes at a worktable, visible products and packaging, natural coherent hands and clean professional lighting."],
  ["Tercero, mide los resultados: cuántos preguntan, cuántos compran y cuánto cuesta atenderlos. Ajusta con esos datos. La disciplina convierte ideas en resultados.", "person analyzing business data and charts", ["business analytics laptop charts", "person analyzing spreadsheet"], ["person analyzing data using a computer or documents", "a chart, table or spreadsheet visible"], ["generic typing with no data", "blank computer screen", "empty office"], "Professional analyzing business results at a desk, a computer displaying clear chart shapes or a spreadsheet, visible person and data together, natural coherent anatomy. No invented readable numbers or lettering."],
] as const;
export const SCRIPT: GeneratedScript = { title: "Tres decisiones para empezar un negocio", segments: definitions.map(([text, subject, alternatives, mustShow, mustNotShow, prompt], index) => ({
  text, visualQuery: alternatives[0], visualConcepts: [...alternatives], energy: index === 0 ? "high" : "medium", emphasisWords: [LABELS[index]],
  visualIntent: VisualIntentSchema.parse({ source: "stock", subject, mustShow: [...mustShow], mustNotShow: [...mustNotShow],
    imagePrompt: "Polished realistic editorial illustration, vertical 9:16 safe composition. Keep the person and defining action visible within the central safe area at maximum camera zoom. Sharp details, deliberate lighting, coherent geometry and anatomy, no watermark or unrelated lettering. " + prompt }),
})) };
export const LIMITS = { version: "reel-stock-trial/1", ownerId: OWNER, requestId: REQUEST, sceneCount: 4, maxImages: 4, maxReviews: 20,
  maxAccountedUsd: 0.60, maxVoiceCalls: 2, maxVoiceCharacters: 650, voiceId: "uYlzyj2kIZo3HfBB21vF", modelId: "eleven_multilingual_v2",
  maxImageReservationUsd: 0.08, voiceEstimatedUsdPer1kChars: 0.1, durationSeconds: 30, reviewPolicy: "literal-visual-quality/2" } as const;
export const PLAN_HASH = stableHash({ script: SCRIPT, limits: LIMITS }, 64);
if (process.argv.includes("--check")) console.log(JSON.stringify({ script: SCRIPT, limits: LIMITS, planHash: PLAN_HASH,
  voiceCharacters: SCRIPT.segments.map(s => s.text).join(" ").length, paidCalls: 0 }));
