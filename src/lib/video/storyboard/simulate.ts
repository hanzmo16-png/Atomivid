/**
 * Construye un storyboard determinístico SIN llamar a ningún proveedor de
 * IA — usa reglas simples sobre los campos que el guion YA trae
 * (visualQuery/visualConcepts/energy/excludedTerms). Sirve para:
 *  - Pruebas unitarias del resto del pipeline (footage/costos/QA) sin red.
 *  - El modo dry-run (ver scripts/dry-run-storyboard.ts) cuando no hay
 *    ANTHROPIC_API_KEY o el usuario quiere previsualizar sin gastar nada.
 *
 * NO pretende tener la calidad semántica del Visual Director real — es
 * una aproximación mecánica, documentada como tal (nunca se presenta como
 * evaluación real, ver principio del modo simulación en el resto del
 * proyecto: quality-gate.ts, footage-score.ts).
 */
import type { GeneratedScript } from "@/lib/providers/types";
import type { Storyboard, StoryboardScene, FallbackStep } from "./types";

const DEFAULT_FALLBACK: FallbackStep[] = [
  "retry_prompt",
  "alternate_provider",
  "validated_stock",
  "motion_graphic",
];

export function simulateStoryboard(script: GeneratedScript): Storyboard {
  const scenes: StoryboardScene[] = script.segments.map((segment, i) => {
    const isFirst = i === 0;
    const isLast = i === script.segments.length - 1;
    const concepts = segment.visualConcepts?.length ? segment.visualConcepts : [segment.visualQuery];

    return {
      id: `scene-${i}`,
      order: i,
      narrationText: segment.text,
      estimatedDurationSeconds: Math.max(1.8, segment.text.split(/\s+/).filter(Boolean).length / 2.8),
      literalMeaning: segment.text,
      emotionalSubtext: "no analizado (modo simulación, sin llamada a IA)",
      narrativeGoal: isFirst ? "gancho inicial" : isLast ? "cierre memorable" : "desarrollo",
      dominantEmotion: segment.energy === "high" ? "energía/urgencia" : segment.energy === "low" ? "calma/introspección" : "determinación",
      energy: segment.energy ?? "medium",
      subject: concepts[0] ?? "person",
      visibleAction: concepts[0] ?? segment.visualQuery,
      environment: "no especificado (modo simulación)",
      timeOfDay: "no especificado (modo simulación)",
      shotType: isFirst ? "medium close-up" : "medium shot",
      cameraMovement: isFirst ? "slow push-in" : "static or slow pan",
      lighting: "no especificado (modo simulación)",
      colorPalette: "no especificado (modo simulación)",
      visualStyle: "cinematic, realistic, not stylized",
      imagePrompt: `${concepts[0] ?? segment.visualQuery}, cinematic, vertical composition, realistic, natural lighting`,
      negativePrompt: "text overlay, watermark, logo, deformed hands, unconscious person, violence, medical imagery" +
        (segment.excludedTerms?.length ? `, ${segment.excludedTerms.join(", ")}` : ""),
      // El schema exige al menos 2 consultas alternativas — si el guion
      // solo trae un concepto (guiones viejos sin visualConcepts, o el
      // proveedor fixture), se completa con una variante genérica en vez
      // de violar el contrato.
      stockQueries: concepts.length >= 2 ? concepts.slice(0, 4) : [concepts[0] ?? segment.visualQuery, `${concepts[0] ?? segment.visualQuery} close up`],
      resourceType: "stock_video",
      priority: isFirst ? 1 : isLast ? 2 : 3,
      confidence: 0.5,
      selectionRationale: "generado por reglas deterministas (modo simulación), no por análisis semántico real",
      continuityWithPrevious: isFirst ? "none" : "mantener paleta y nivel de realismo de la escena anterior",
      continuityWithNext: isLast ? "none" : "preparar transición hacia la siguiente escena",
      maxCostUsd: 0,
      fallbackStrategy: DEFAULT_FALLBACK,
    };
  });

  return {
    visualIdentity: {
      characterAgeAndAppearance: "no analizado (modo simulación)",
      wardrobe: "no analizado (modo simulación)",
      place: "no analizado (modo simulación)",
      colorPalette: "no analizado (modo simulación)",
      lighting: "no analizado (modo simulación)",
      realismLevel: "photorealistic, not stylized",
      aspectRatio: "9:16",
      emotionalTone: "no analizado (modo simulación)",
      narrativeArc: "no analizado (modo simulación)",
    },
    hookDescription: "no analizado (modo simulación) — ver escena 0",
    closingDescription: "no analizado (modo simulación) — ver última escena",
    scenes,
  };
}
