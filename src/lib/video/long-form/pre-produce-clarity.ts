/**
 * Resumen que se ve justo antes de «Confirmar y generar video».
 * Solo reúne cifras que la pantalla ya calcula (plan + comprobación previa).
 * No estima un techo nuevo ni autoriza gasto.
 */
import { LONG_FORM_DURATION_TOLERANCE } from "./duration-budget";

export type ClarityCeiling =
  | { label: "Techo que se autorizaría"; amount: number }
  | { label: "Techo que se autorizaría"; unavailable: "no cabe" }
  | { label: "Límite autorizado por producción"; amount: number }
  | { label: "Costo estimado de producción"; amount: number };

export type PreProduceInput = {
  topic: string;
  publicationTitle?: string | null;
  requestedDurationSeconds?: number;
  durationSeconds: number;
  stockVideoCount: number;
  stockImageCount: number;
  aiImageCount: number;
  aiVideoClipCount: number;
  deterministicCount: number;
  /** Plan con Recraft: las imágenes cuentan como originales, no como «imágenes IA». */
  originals?: boolean;
  estimatedProviderCostUsd: number;
  preflight?: {
    limitUsd: number;
    authorization: { authorizedCeilingUsd: number | null } | null;
  } | null;
};

export type PreProduceFact = {
  video: string;
  topicLine: string | null;
  duration: string;
  durationNote: string | null;
  visuals: string;
  ceiling: ClarityCeiling;
};

export function formatPlanDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes > 0 ? `${minutes} min ${rest.toString().padStart(2, "0")} s` : `${rest} s`;
}

/** El techo que la comprobación previa ya muestra. Si no hay autorización, el límite o el costo del plan. */
export function clarityCeiling(input: Pick<PreProduceInput, "estimatedProviderCostUsd" | "preflight">): ClarityCeiling {
  const authorization = input.preflight?.authorization;
  if (authorization) {
    if (authorization.authorizedCeilingUsd === null) return { label: "Techo que se autorizaría", unavailable: "no cabe" };
    return { label: "Techo que se autorizaría", amount: authorization.authorizedCeilingUsd };
  }
  if (input.preflight) return { label: "Límite autorizado por producción", amount: input.preflight.limitUsd };
  return { label: "Costo estimado de producción", amount: input.estimatedProviderCostUsd };
}

export function preProduceClarity(input: PreProduceInput): PreProduceFact {
  const title = input.publicationTitle?.trim() ?? "";
  const topic = input.topic.trim();
  const video = title && title !== topic ? title : topic || "Este documental";
  const requested = input.requestedDurationSeconds;
  const estimated = `~${formatPlanDuration(input.durationSeconds)}`;
  const duration = requested === undefined
    ? `estimada ${estimated}`
    : `pedida ${formatPlanDuration(requested)} · estimada ${estimated}`;
  const differs = requested !== undefined && requested > 0
    && Math.abs(input.durationSeconds / requested - 1) > LONG_FORM_DURATION_TOLERANCE;
  const stock = input.stockVideoCount + input.stockImageCount;
  const images = input.originals
    ? countEs(input.aiImageCount, "imagen original", "imágenes originales")
    : countEs(input.aiImageCount, "imagen IA", "imágenes IA");
  return {
    video,
    topicLine: title && title !== topic ? topic : null,
    duration,
    durationNote: differs ? "El costo y el tiempo de producción corresponden a la duración estimada." : null,
    visuals: [
      countEs(stock, "recurso de archivo", "recursos de archivo"),
      images,
      countEs(input.aiVideoClipCount, "clip de video IA", "clips de video IA"),
      countEs(input.deterministicCount, "tarjeta de texto", "tarjetas de texto"),
    ].join(" · "),
    ceiling: clarityCeiling(input),
  };
}

function countEs(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
