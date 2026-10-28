import type { MaterialPlanCheck } from "./material-plan";
import type { VisualStrategy } from "./production-plan-types";

/** Frase del impedimento de material (Configurar y confirm-production, mismo texto). Null si no hay impedimento. */
export function materialBlockText(material: MaterialPlanCheck | undefined, strategy: VisualStrategy): string | null {
  if (material?.status !== "unavoidable_gap") return null;
  const ids = `${material.shotIds.slice(0, 6).join(", ")}${material.shotIds.length > 6 ? ", …" : ""}`;
  return strategy === "economical"
    ? `no hay material de archivo pertinente y único para ${material.missing} escena(s) (${ids}). Económico no usa imágenes IA: elige Equilibrado o Cinemático, que las cubren con imágenes IA incluidas en su techo.`
    : `quedarían ${material.missing} escena(s) sin material (${ids}) incluso con ${material.promoted} imagen(es) IA. Hace falta material verificado o una adaptación editorial del guion.`;
}
