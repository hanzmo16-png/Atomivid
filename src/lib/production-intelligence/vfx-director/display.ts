/** Readable project names; the technical identifier stays available in audit details. */
const PROJECT_NAMES: Record<string, string> = {
  "precampaign-three-worlds-v1-preparation": "Precampaña · Tres mundos (Nueva York, playa y luna)",
};
export function projectName(id: string): string {
  if (PROJECT_NAMES[id]) return PROJECT_NAMES[id];
  const words = id.replace(/[-_]+/g, " ").replace(/\bv(\d+)\b/gi, "v$1").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Proyecto sin nombre";
}
const PROJECT_DESCRIPTIONS: Record<string, string> = {
  "precampaign-three-worlds-v1-preparation": "Preparación aprobada de tres fondos; los píxeles originales de Hans se conservan.",
};
export const projectDescription = (id: string, intent: string) => PROJECT_DESCRIPTIONS[id] ?? intent;
const LIGHTING: Record<string, string> = { night_practical: "Noche con luces prácticas", daylight_soft: "Luz de día suave", sun_hard: "Sol duro sin atmósfera", other: "Luz propia" };
/** Plans may store the lighting identifier as their light text; show it in words. */
export const lightingText = (text: string) => text.replace(/\b(night_practical|daylight_soft|sun_hard)\b/g, m => LIGHTING[m]);
