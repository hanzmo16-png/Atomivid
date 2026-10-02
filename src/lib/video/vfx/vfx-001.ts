/**
 * ATOMIVID_VFX_001_HANS_NYC_TRANSFORMATION — prepared, NOT executed. Status stays
 * READY_FOR_SOURCE_VIDEO until the new real walking take of Hans exists. When it does, the only
 * allowed step is `buildVfxSpendPlan` (pure: no provider, no network); the paid generation needs a
 * later human authorization after reading VFX_001_SPEND_PLAN.
 */
import { costFromRate, findVfxRate } from "@/lib/providers/vfx/pricing";
import { LUMA_PLANNING_LIMITS, LUMA_VFX_CONTRACT_VERIFIED, lumaModeFor, lumaPlanningOutput, type LumaModifyModel } from "@/lib/providers/vfx/luma";
import type { VfxSource, VfxTransformRequest } from "@/lib/providers/vfx/types";

export const VFX_001 = {
  id: "ATOMIVID_VFX_001_HANS_NYC_TRANSFORMATION",
  status: "READY_FOR_SOURCE_VIDEO" as "READY_FOR_SOURCE_VIDEO" | "SOURCE_RECEIVED_PLAN_ONLY",
  provider: "luma",
  format: { aspectRatio: "9:16" as const, width: 1080, height: 1920 },
  /** Target length of the VFX range. */
  rangeSeconds: { min: 5, max: 8 },
  targetBudgetUsd: 2.0,
  hardCapUsd: 5.0,
  preserveSubject: true,
  strength: "balanced" as const,
  style: "cinematic New York City street at night, premium film look",
  prompt:
    "The same man keeps walking toward the fixed camera and talking, exactly as in the source: same face, same identity, same body, " +
    "same clothes, same hand and body movement, same timing. Only his surroundings change: the apartment gradually becomes a cinematic " +
    "New York City street at night — wet asphalt with reflections, warm streetlights, brownstones and avenue lights far behind him in soft " +
    "bokeh, gentle real ambient motion of distant traffic and steam. The city light falls on him realistically. Deep, premium, cinematic.",
  negativePrompt:
    "different person, face change, regenerated face, facial morphing, age change, clothing change, deformed hands, extra fingers, " +
    "distorted body, sudden background swap, chroma-key edges, green-screen look, cartoon, oversaturated neon, crowded Times Square billboards, " +
    "flicker, TikTok filter look",
  priorities: ["identidad", "movimiento corporal", "continuidad temporal", "transformar sobre todo el entorno", "iluminación integrada", "acabado cinematográfico"],
  /**
   * Progressive change: Modify transforms the whole range, so the "apartment → New York" progression
   * is built locally (ffmpeg, USD 0): the untouched source plays first and blends into the
   * transformed range over the transition window. No second paid call for the transition.
   */
  progression: { method: "local_crossfade_source_to_transformed", transitionSeconds: 1.5 },
} as const;

export type VfxPlanCandidate = {
  model: LumaModifyModel;
  mode: string;
  rangeSeconds: number;
  outputPlanning: { width: number; height: number; fps: number };
  estimatedUsd: number;
  maxAttemptsWithinCap: number;
  fitsTarget: boolean;
  pricingVerified: boolean;
};

export type VfxSpendPlan = {
  id: string;
  plan: "VFX_001_SPEND_PLAN";
  provider: string;
  source: { sha256: string; durationSeconds: number; width: number; height: number; fps: number; range: { startSeconds: number; endSeconds: number } };
  candidates: VfxPlanCandidate[];
  recommended: VfxPlanCandidate | null;
  targetBudgetUsd: number;
  hardCapUsd: number;
  maximumCostUsd: number;
  maxPaidAttempts: number;
  reuse: string;
  onFailure: string[];
  blockers: string[];
  requiresHumanAuthorization: true;
};

const MAX_PAID_ATTEMPTS = 2;

/** Pure: builds the spend plan from the probed source. Never calls a provider. */
export function buildVfxSpendPlan(source: Omit<VfxSource, "url">, range?: { startSeconds: number; endSeconds: number }): VfxSpendPlan {
  const len = Math.min(VFX_001.rangeSeconds.max, source.durationSeconds);
  const r = range ?? { startSeconds: 0, endSeconds: len };
  const rangeSeconds = r.endSeconds - r.startSeconds;
  const blockers: string[] = [];
  if (Math.abs(source.width / source.height - 9 / 16) > 0.02) blockers.push(`El clip no es 9:16 (${source.width}x${source.height}).`);
  if (rangeSeconds < VFX_001.rangeSeconds.min - 1e-6) blockers.push(`El tramo dura ${rangeSeconds.toFixed(2)} s (< ${VFX_001.rangeSeconds.min} s).`);
  if (!LUMA_VFX_CONTRACT_VERIFIED) blockers.push("Contrato Luma video-to-video no verificado contra la documentación primaria (Modify Video Dream Machine v1 vs Ray3.2 video_edit).");
  const req = { aspectRatio: VFX_001.format.aspectRatio, range: r, strength: VFX_001.strength, preserveSubject: VFX_001.preserveSubject } as Pick<VfxTransformRequest, "aspectRatio" | "range" | "strength" | "preserveSubject">;
  const out = lumaPlanningOutput(req);
  const candidates: VfxPlanCandidate[] = (["ray-flash-2", "ray-2"] as const)
    .filter((model) => rangeSeconds <= LUMA_PLANNING_LIMITS.maxRangeSeconds[model])
    .map((model) => {
      const rate = findVfxRate("luma", model)!;
      const estimatedUsd = costFromRate(rate, out);
      return { model, mode: lumaModeFor(req), rangeSeconds, outputPlanning: { width: out.width, height: out.height, fps: out.fps }, estimatedUsd, maxAttemptsWithinCap: Math.min(MAX_PAID_ATTEMPTS, Math.floor((VFX_001.hardCapUsd + 1e-9) / estimatedUsd)), fitsTarget: estimatedUsd <= VFX_001.targetBudgetUsd, pricingVerified: rate.verified };
    });
  if (candidates.some((c) => !c.pricingVerified)) blockers.push("Tarifas Luma no verificadas contra la página de precios oficial (estimaciones solo orientativas).");
  const recommended = candidates.filter((c) => c.model === "ray-2" && c.fitsTarget)[0] ?? candidates.find((c) => c.fitsTarget) ?? null;
  const maxPaidAttempts = recommended ? recommended.maxAttemptsWithinCap : 0;
  return {
    id: VFX_001.id,
    plan: "VFX_001_SPEND_PLAN",
    provider: VFX_001.provider,
    source: { sha256: source.sha256, durationSeconds: source.durationSeconds, width: source.width, height: source.height, fps: source.fps, range: r },
    candidates,
    recommended,
    targetBudgetUsd: VFX_001.targetBudgetUsd,
    hardCapUsd: VFX_001.hardCapUsd,
    maximumCostUsd: recommended ? Math.min(VFX_001.hardCapUsd, recommended.estimatedUsd * maxPaidAttempts) : 0,
    maxPaidAttempts,
    reuse: "Identidad = sha256 del tramo + proveedor + modelo + prompt + negativo + rango + 9:16 + preservar sujeto + intensidad + estilo + calidad + semilla. El resultado se guarda en `${requestId}/paid/<key>.mp4` (sha256 verificado) y cualquier reintento lo reutiliza con 0 llamadas.",
    onFailure: [
      "Rechazo antes de aceptar (4xx/validación): fila REFUNDED, sin reintento automático; nuevo intento solo con nueva autorización.",
      "Fallo incierto (red cortada tras enviar): RECONCILIATION_REQUIRED, ninguna nueva llamada hasta conciliar.",
      "Trabajo aceptado y fallo al sondear/descargar: PROVIDER_JOB_RECORDED → se reanuda ese mismo trabajo, nunca se reenvía.",
      "Resultado de baja calidad: se detiene y se informa; un segundo intento (otra variante) requiere autorización y cabe en el tope.",
    ],
    blockers,
    requiresHumanAuthorization: true,
  };
}
