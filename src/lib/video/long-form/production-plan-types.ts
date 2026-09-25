/**
 * Tipos/etiquetas del ProductionPlan SIN dependencias de servidor — el
 * componente cliente (ConfigureProduction.tsx) importa solo esto, nunca
 * production-plan.ts (que lee tarifas de proveedores y env vars).
 */
import { VISUAL_STRATEGIES, type VisualStrategy } from "./shots";

export { VISUAL_STRATEGIES };
export type { VisualStrategy };

/** v2: allocation + desglose de costos + scriptHash + asignación real (elegibilidad/cost guard) por shot. */
export const PRODUCTION_PLAN_VERSION = 2;
/** Versiones que el worker sabe ejecutar (v1 con allocation conservadora derivada, ver executionAllocation). */
export const EXECUTABLE_PLAN_VERSIONS = [1, 2] as const;

export const VISUAL_STRATEGY_LABEL: Record<VisualStrategy, string> = {
  economical: "Económico / archivo",
  balanced: "Equilibrado",
  cinematic: "Cinemático / IA",
};

export const VISUAL_STRATEGY_DESCRIPTION: Record<VisualStrategy, string> = {
  economical: "Solo material de archivo real (video e imagen) y tarjetas de texto — cero imágenes o video generados por IA.",
  balanced: "Archivo real con algunas imágenes generadas por IA donde el archivo no alcanza — sin clips de video IA.",
  cinematic:
    "Más imágenes generadas por IA y clips de video IA solo donde el movimiento aporta a la historia — nunca todo el video con IA.",
};

export type ProductionPlanAllocation = {
  /** Generaciones de imagen IA permitidas (incluye las imágenes de referencia de cada clip de video IA). */
  maxAiImageGenerations: number;
  maxAiVideoClips: number;
  /** Tope USD de imagen + video IA — el worker nunca lo excede, ni con fallbacks. */
  maxGenerativeUsd: number;
};

export type ProductionPlan = {
  version: number;
  strategy: VisualStrategy;
  durationSeconds: number;
  shotCount: number;
  stockVideoCount: number;
  /** Imagen de archivo (incluye Ken Burns). */
  stockImageCount: number;
  /** Shots de imagen IA (sin contar las referencias de video IA). */
  aiImageCount: number;
  aiVideoClipCount: number;
  /** Segundos EN PANTALLA de video IA. */
  aiVideoSeconds: number;
  /** Segundos FACTURADOS por el proveedor (Veo genera clips de duración fija). */
  aiVideoBilledSeconds?: number;
  /** Tarjetas de texto (tema + narración) — sin costo. */
  deterministicCount: number;
  voiceCharacters: number;
  /** Hash del guion confirmado — el worker se niega a ejecutar si el guion cambió después de confirmar. */
  scriptHash?: string;
  /** Si el video IA está habilitado en este entorno al momento del plan. */
  aiVideoAvailable?: boolean;
  /**
   * Escenas planeadas por beat (P0 2026-09-25: plan 69 vs ejecución 74). El
   * worker reparte cada beat en EXACTAMENTE este número de escenas cuando la
   * duración real narrada lo permite (3-8 s por escena), así lo mostrado al
   * confirmar es lo que se ejecuta. Ausente en planes anteriores.
   */
  beatShotCounts?: Record<string, number>;
  /** Duración pedida por el usuario (s) — para mostrar la desviación de la estimación. */
  requestedDurationSeconds?: number;
  providers: { voice: string; footage: string; image: string; aiVideo: string; music: string };
  estimatedVoiceCostUsd?: number;
  estimatedImageCostUsd?: number;
  estimatedAiVideoCostUsd?: number;
  estimatedProviderCostUsd: number;
  allocation?: ProductionPlanAllocation;
  /** Todavía no existe un sistema de créditos real — nunca se inventa un saldo. */
  estimatedCredits: number | null;
  confirmedAt: string | null;
};

export function isProductionPlan(value: unknown): value is ProductionPlan {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ProductionPlan>;
  return (
    typeof v.version === "number" &&
    typeof v.strategy === "string" &&
    (VISUAL_STRATEGIES as readonly string[]).includes(v.strategy) &&
    typeof v.durationSeconds === "number" &&
    typeof v.shotCount === "number" &&
    typeof v.estimatedProviderCostUsd === "number"
  );
}

export function isExecutablePlanVersion(version: number): boolean {
  return (EXECUTABLE_PLAN_VERSIONS as readonly number[]).includes(version);
}

/**
 * Límites de ejecución a partir del snapshot confirmado. v2 trae su
 * allocation explícita; v1 (antes de esta versión) no la tenía — se
 * deriva de forma CONSERVADORA: sus imágenes IA como tope y cero video IA
 * (en v1 el video IA nunca era alcanzable en la práctica).
 */
export function executionAllocation(plan: ProductionPlan): ProductionPlanAllocation {
  if (plan.allocation) return plan.allocation;
  return {
    maxAiImageGenerations: plan.aiImageCount,
    maxAiVideoClips: 0,
    maxGenerativeUsd: Math.max(0, plan.estimatedProviderCostUsd),
  };
}
