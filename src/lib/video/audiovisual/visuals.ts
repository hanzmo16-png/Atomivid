/**
 * Coherencia visual de la dirección: prompt con el estilo del perfil para
 * cada escena y comprobación de disponibilidad/presupuesto ANTES de
 * cualquier gasto. Puro (recibe flags y tarifas como parámetros).
 *
 * Política explícita:
 *  - Perfiles ilustrados (3D, anime, cómic): cada escena necesita su imagen
 *    generada con el estilo del perfil. Si la generación no está habilitada,
 *    no alcanza el presupuesto o falla, la producción se detiene con un
 *    motivo visible — NUNCA se sustituye en silencio por stock realista.
 *  - Perfiles de stock (Cine realista, Horror y misterio): stock como hoy;
 *    Horror añade un modificador de búsqueda y el grado oscuro.
 *  - Elegir una apariencia nunca autoriza video generado (Veo u otros).
 */
import { createHash } from "node:crypto";
import { PROFILES, type IntentId, type ProfileId } from "./catalog";

export const INTENT_LIGHTING: Record<IntentId, string> = {
  suspense: "low-key lighting, deep shadows, cold muted palette, ominous atmosphere",
  humor: "bright even lighting, vivid cheerful palette, expressive exaggerated poses",
  uplifting: "warm golden light, hopeful mood, open composition",
  informative: "clear balanced lighting, readable composition, neutral palette",
  reflective: "soft diffused light, gentle warm palette, quiet intimate mood",
  action: "dramatic rim lighting, strong motion, dynamic diagonal composition",
};

export type StyledImagePrompt = { prompt: string; negativePrompt: string; key: string };

/**
 * Prompt autocontenido por escena: estilo del perfil + tratamiento de la
 * intención + contenido de la escena. `key` (hash) forma parte de la ruta en
 * Storage: mismo prompt → misma ruta → un reintento reutiliza la imagen sin
 * volver a pagar; prompt distinto (guion, perfil o intención cambiados) →
 * ruta nueva → nunca se reutiliza una imagen que ya no corresponde.
 */
export function buildStyledImagePrompt(input: {
  profile: ProfileId;
  intent: IntentId;
  concept: string;
  narration: string;
}): StyledImagePrompt {
  const profile = PROFILES[input.profile];
  if (profile.visualSource !== "generated_image" || !profile.imageStyle) {
    throw new Error(`El perfil ${input.profile} no usa imágenes generadas`);
  }
  const narration = input.narration.replace(/\s+/g, " ").trim().slice(0, 280);
  const prompt =
    `${profile.imageStyle}. Scene: ${input.concept.trim()}. Mood: ${INTENT_LIGHTING[input.intent]}. ` +
    `Story context (do not render as text): "${narration}". Vertical 9:16 composition, main subject clearly readable on a phone screen, no text or lettering in the image.`;
  const negativePrompt = profile.imageNegative ?? "text, watermark, logo";
  const key = createHash("sha256").update(`${prompt}\n${negativePrompt}`).digest("hex").slice(0, 12);
  return { prompt, negativePrompt, key };
}

export function styledImageObjectPrefix(sceneIndex: number, key: string): string {
  return `scene-${sceneIndex}-styled-${key}`;
}

export type VisualAvailability =
  | { ok: true; source: "stock" }
  | { ok: true; source: "generated_image"; images: number; estimatedCostUsd: number; maxCostUsd: number; provider: string }
  | { ok: false; code: "generation_disabled" | "provider_unavailable" | "too_many_scenes" | "over_budget"; message: string; recovery: string };

/**
 * Disponibilidad y presupuesto para una apariencia, con el número real de
 * escenas del guion aprobado. Se evalúa en la revisión (para mostrarlo), al
 * aprobar (bloquea antes de gastar) y otra vez en el worker.
 */
export function checkVisualAvailability(input: {
  profile: ProfileId;
  sceneCount: number;
  imageGenerationEnabled: boolean;
  /** Nombre del proveedor que se usaría, o null si no hay ninguno utilizable. */
  imageProvider: string | null;
  estimatedCostPerImageUsd: number;
  maxVisualCostUsd: number;
  maxStyledImages: number;
  /** «Animación IA»: todos los perfiles (también los de stock) necesitan una ilustración base por escena. */
  needsBaseImages?: boolean;
}): VisualAvailability {
  const profile = PROFILES[input.profile];
  if (profile.visualSource === "stock" && !input.needsBaseImages) return { ok: true, source: "stock" };
  const recovery = "Elige «Cine realista» o «Horror y misterio» (usan clips reales), o pide que se habilite la generación de imágenes.";
  if (!input.imageGenerationEnabled) {
    return { ok: false, code: "generation_disabled", message: `«${profile.label}» necesita imágenes generadas y la generación de imágenes no está habilitada.`, recovery };
  }
  if (!input.imageProvider) {
    return { ok: false, code: "provider_unavailable", message: `«${profile.label}» necesita un proveedor de imágenes configurado.`, recovery };
  }
  if (input.sceneCount > input.maxStyledImages) {
    return {
      ok: false,
      code: "too_many_scenes",
      message: `Este guion tiene ${input.sceneCount} escenas y el máximo para «${profile.label}» es ${input.maxStyledImages}.`,
      recovery: "Une escenas en la revisión del guion o elige una dirección con clips reales.",
    };
  }
  const estimatedCostUsd = Math.round(input.sceneCount * input.estimatedCostPerImageUsd * 10000) / 10000;
  if (estimatedCostUsd > input.maxVisualCostUsd) {
    return {
      ok: false,
      code: "over_budget",
      message: `«${profile.label}» necesita ${input.sceneCount} imágenes (~US$${estimatedCostUsd.toFixed(2)}) y el tope por video es US$${input.maxVisualCostUsd.toFixed(2)}.`,
      recovery: "Reduce escenas o elige una dirección con clips reales.",
    };
  }
  return { ok: true, source: "generated_image", images: input.sceneCount, estimatedCostUsd, maxCostUsd: input.maxVisualCostUsd, provider: input.imageProvider };
}

/** Consultas de stock con el modificador del perfil primero (p. ej. «dark» en Horror), luego las originales. */
export function stockConceptsFor(profile: ProfileId, concepts: string[]): string[] {
  const modifier = PROFILES[profile].stockQueryModifier;
  if (!modifier || concepts.length === 0) return concepts;
  return [`${concepts[0]} ${modifier}`, ...concepts];
}

/**
 * Grado final del Reel: el del perfil; en Cine realista, una historia de
 * suspenso o emotiva oscurece/templa ligeramente la imagen (la emoción
 * responde a la historia). Los perfiles ilustrados llevan el tratamiento en
 * la propia imagen generada.
 */
export function reelLookFor(profile: ProfileId, intent: IntentId): { filter: string; vignette: number; tint?: string } | undefined {
  const grade = PROFILES[profile].grade;
  if (profile === "cinematic_realistic") {
    if (intent === "suspense") return { filter: "brightness(0.9) contrast(1.08) saturate(0.8)", vignette: 0.35 };
    if (intent === "reflective") return { filter: "contrast(0.97) saturate(0.9)", vignette: 0.2 };
    return undefined;
  }
  if (grade.filter === "none" && grade.vignette === 0 && !grade.tint) return undefined;
  return { ...grade };
}
