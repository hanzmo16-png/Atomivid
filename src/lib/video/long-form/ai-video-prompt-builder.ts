/**
 * VideoPromptBuilder de Long Form — transforma narración + intención
 * visual + contexto + descripción de movimiento + duración/aspecto en UN
 * `VideoGenerationRequest` normalizado (providers/types.ts), sin acoplarse
 * a ningún proveedor concreto.
 *
 * La separación "GenericPrompt → ProviderAdapter → prompt específico del
 * proveedor" que pide la sección 9 del encargo YA EXISTE en el código: un
 * `VideoGenerationRequest` ES el GenericPrompt (proveedor-agnóstico), y
 * cada implementación de `VideoProvider.generateVideo()` (fixture.ts,
 * runway.ts) YA es su propio ProviderAdapter — traduce ese request a su
 * payload HTTP concreto internamente (ver runway.ts: `promptText`/`ratio`/
 * `duration`). Este módulo NO duplica esa capa — solo construye el lado
 * genérico, de forma consistente, en un único lugar (evita que cada
 * llamador arme el prompt libremente y de forma inconsistente).
 */
import type { VideoGenerationRequest } from "@/lib/providers/types";

export type VideoPromptBuilderInput = {
  /** Texto EXACTO de la narración que cubre este shot — nunca se reescribe aquí. */
  narration?: string;
  /** Intención visual de la escena (mismo campo que Shot.visualIntent / storyboard queryOrPrompt). */
  visualIntent: string;
  /** Contexto histórico/temático adicional a incorporar al prompt (p. ej. era, estilo visual del documental). */
  contextNotes?: string[];
  /** Descripción del movimiento/cámara deseado (Shot.motionDescription). */
  motionDescription?: string;
  /** Elementos a evitar — se combinan con cualquier negativo compartido del llamador. */
  negativeSignals?: string[];
  /** Referencia a una imagen ya existente para animación image-to-video (Shot.referenceAsset). */
  referenceImageUrl?: string;
  durationSeconds: number;
  aspectRatio: VideoGenerationRequest["aspectRatio"];
  maxCostUsd: number;
  seed?: string;
  /** Metadata de trazabilidad (p. ej. shotId/videoId) — nunca interpretada por el proveedor. */
  metadata?: Record<string, string>;
};

/**
 * Compone el prompt final combinando, en orden estable: intención visual →
 * descripción de movimiento (si hay) → notas de contexto (si hay). Nunca
 * incluye la narración TAL CUAL en el prompt visual (la narración es lo
 * que se DICE, no necesariamente lo que se MUESTRA) — se expone aparte
 * (`narration`) solo para que un adaptador futuro que sí la necesite
 * (p. ej. sincronización labial) pueda leerla del input original.
 */
function composePromptText(input: VideoPromptBuilderInput): string {
  const parts = [input.visualIntent.trim()];
  if (input.motionDescription?.trim()) parts.push(`Motion: ${input.motionDescription.trim()}`);
  if (input.contextNotes?.length) parts.push(...input.contextNotes.map((n) => n.trim()).filter(Boolean));
  return parts.filter(Boolean).join(". ");
}

function composeNegativePrompt(input: VideoPromptBuilderInput): string | undefined {
  const signals = (input.negativeSignals ?? []).map((s) => s.trim()).filter(Boolean);
  if (signals.length === 0) return undefined;
  return signals.join(", ");
}

/**
 * Construye el `VideoGenerationRequest` normalizado — pura, sin red, sin
 * decidir NADA sobre elegibilidad ni presupuesto (eso ya se decidió antes,
 * ver ai-video-eligibility.ts/ai-video-cost-guard.ts). Lanza si falta algo
 * imprescindible para pedir un clip (nunca compone un prompt vacío).
 */
export function buildVideoGenerationRequest(input: VideoPromptBuilderInput): VideoGenerationRequest {
  if (!input.visualIntent.trim()) {
    throw new Error("buildVideoGenerationRequest: visualIntent vacío — no hay nada que describir en el prompt.");
  }
  if (!(input.durationSeconds > 0)) {
    throw new Error(`buildVideoGenerationRequest: durationSeconds inválido (${input.durationSeconds}).`);
  }

  const prompt = composePromptText(input);
  const negativePrompt = composeNegativePrompt(input);

  return {
    prompt,
    ...(negativePrompt ? { negativePrompt } : {}),
    aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds,
    maxCostUsd: input.maxCostUsd,
    ...(input.referenceImageUrl ? { referenceImageUrl: input.referenceImageUrl } : {}),
    ...(input.seed ? { seed: input.seed } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
