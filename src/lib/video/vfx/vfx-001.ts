/**
 * ATOMIVID_VFX_001_HANS_NYC_TRANSFORMATION — prepared, NOT executed. Status stays
 * WAITING_FOR_HANS_SOURCE_VIDEO until the new real walking take of Hans exists. Then the only
 * allowed step is `buildVfxSpendPlan` (pure: no provider, no network) → VFX_001_SPEND_PLAN, and a
 * STOP before the first paid call: generation needs a later human authorization.
 */
import { findVfxPrice } from "@/lib/providers/vfx/pricing";
import { LUMA_MAX_SOURCE_SECONDS, LUMA_VFX_MODEL, LUMA_VFX_REQUEST_TYPE, lumaControlsFor, lumaStrengthFor } from "@/lib/providers/vfx/luma";
import type { VfxEditControls, VfxResolution, VfxSource } from "@/lib/providers/vfx/types";

/**
 * First test, conservative (never the reimagine band): face identity on; pose followed precisely;
 * motion trajectory kept; depth kept but with high blur (0.7) so the walking perspective and the
 * subject's placement hold while the apartment's geometry can become a street; normals off so
 * surfaces may be reinterpreted. Strength "balanced" → flex_1 (lowest flex level).
 */
export const VFX_001_CONTROLS: VfxEditControls = {
  faceIdentity: true,
  pose: "precise",
  trajectory: { enabled: true },
  depth: { enabled: true, freedom: 0.7 },
  normals: { enabled: false },
};

export const VFX_001 = {
  id: "ATOMIVID_VFX_001_HANS_NYC_TRANSFORMATION",
  status: "WAITING_FOR_HANS_SOURCE_VIDEO" as const,
  provider: "luma",
  model: LUMA_VFX_MODEL,
  requestType: LUMA_VFX_REQUEST_TYPE,
  format: { aspectRatio: "9:16" as const, width: 1080, height: 1920 },
  /** The source is trimmed locally to exactly this length (video_edit output = source length; priced step). */
  sourceSeconds: 5,
  resolution: "720p" as VfxResolution,
  dynamicRange: "sdr" as const,
  expectedCostUsd: 1.08,
  targetBudgetUsd: 2.0,
  hardCapUsd: 5.0,
  preserveSubject: true,
  strength: "balanced" as const,
  controls: VFX_001_CONTROLS,
  /**
   * Attempt #3 (owner-authorized): positive, neutral description only. Attempts #1/#2 were refused by
   * Luma's content policy (HTTP 422 content_moderated) while the prompt carried an "Avoid:" list with
   * anatomy vocabulary; that list and the style suffix are no longer sent. Subject preservation stays in
   * the documented controls (VFX_001_CONTROLS), unchanged.
   */
  style: "",
  prompt:
    "The same man continues walking naturally toward the fixed camera while speaking, maintaining the appearance and movement " +
    "established by the source video. The surrounding apartment gradually transitions into a cinematic New York City street at night, " +
    "with wet asphalt reflections, warm streetlights, brownstones and avenue lights in soft bokeh, subtle traffic and distant steam. " +
    "Natural realistic city lighting integrates with the existing subject. Premium cinematic film look, photorealistic and temporally coherent.",
  negativePrompt: "",
  priorities: ["identidad", "rostro", "movimiento corporal", "ropa", "continuidad temporal", "transformación del entorno", "integración de iluminación"],
  /**
   * Progressive change: video_edit transforms the whole source, so the "apartment → New York"
   * progression is built locally (ffmpeg, USD 0): the untouched take plays first and blends into the
   * transformed range over the transition window. No second paid call for the transition.
   */
  progression: { method: "local_crossfade_source_to_transformed", transitionSeconds: 1.5 },
} as const;

export type VfxPlanOption = { resolution: VfxResolution; seconds: number; usd: number; role: string; withinTarget: boolean };

export type VfxSpendPlan = {
  id: string;
  plan: "VFX_001_SPEND_PLAN";
  provider: string;
  model: string;
  requestType: string;
  source: { sha256: string; sizeBytes: number; durationSeconds: number; width: number; height: number; fps: number };
  request: { resolution: VfxResolution; dynamicRange: "sdr"; aspectRatio: "9:16"; strength: string; controls: unknown; sourceTransport: string };
  estimatedCostUsd: number | null;
  options: VfxPlanOption[];
  targetBudgetUsd: number;
  hardCapUsd: number;
  maxPaidAttempts: number;
  maxPaidAttemptsWithinTarget: number;
  maximumCostUsd: number;
  reuse: string;
  onFailure: string[];
  blockers: string[];
  requiresHumanAuthorization: true;
};

const MAX_PAID_ATTEMPTS = 2;
const price = (resolution: VfxResolution, seconds: number) => findVfxPrice({ provider: "luma", model: LUMA_VFX_MODEL, requestType: LUMA_VFX_REQUEST_TYPE, resolution, dynamicRange: "sdr", durationSeconds: seconds })?.usd ?? null;

/** Pure: builds the spend plan from the probed, already trimmed source. Never calls a provider. */
export function buildVfxSpendPlan(source: Omit<VfxSource, "url" | "providerFileId">): VfxSpendPlan {
  const blockers: string[] = [];
  if (Math.abs(source.width / source.height - 9 / 16) > 0.02) blockers.push(`El origen no es 9:16 (${source.width}x${source.height}).`);
  if (source.durationSeconds > LUMA_MAX_SOURCE_SECONDS) blockers.push(`El origen dura ${source.durationSeconds.toFixed(2)} s (> ${LUMA_MAX_SOURCE_SECONDS} s).`);
  const est = price(VFX_001.resolution, source.durationSeconds);
  if (est === null) blockers.push(`El origen dura ${source.durationSeconds.toFixed(2)} s: debe recortarse a exactamente ${VFX_001.sourceSeconds} s (precio verificado por tramo de 5/10 s).`);
  const s = VFX_001.sourceSeconds;
  const opt = (resolution: VfxResolution, role: string): VfxPlanOption => {
    const usd = price(resolution, s)!;
    return { resolution, seconds: s, usd, role, withinTarget: usd <= VFX_001.targetBudgetUsd };
  };
  const options: VfxPlanOption[] = [
    opt("720p", "primera prueba (recomendada)"),
    opt("540p", "alternativa más barata / segundo intento dentro del objetivo"),
    opt("1080p", "acabado final solo tras aprobar la prueba de 720p"),
  ];
  const first = est ?? options[0].usd;
  const maxPaidAttempts = Math.min(MAX_PAID_ATTEMPTS, Math.floor((VFX_001.hardCapUsd + 1e-9) / first));
  return {
    id: VFX_001.id,
    plan: "VFX_001_SPEND_PLAN",
    provider: VFX_001.provider,
    model: VFX_001.model,
    requestType: VFX_001.requestType,
    source: { sha256: source.sha256, sizeBytes: source.sizeBytes, durationSeconds: source.durationSeconds, width: source.width, height: source.height, fps: source.fps },
    request: {
      resolution: VFX_001.resolution,
      dynamicRange: "sdr",
      aspectRatio: "9:16",
      strength: lumaStrengthFor({ strength: VFX_001.strength, preserveSubject: VFX_001.preserveSubject }),
      controls: lumaControlsFor(VFX_001.controls),
      sourceTransport: "Luma Files API (POST /files presigned → PUT → complete → ready) → source.file_id; file_id reutilizado por sha256",
    },
    estimatedCostUsd: est,
    options,
    targetBudgetUsd: VFX_001.targetBudgetUsd,
    hardCapUsd: VFX_001.hardCapUsd,
    maxPaidAttempts,
    maxPaidAttemptsWithinTarget: Math.floor((VFX_001.targetBudgetUsd + 1e-9) / first),
    maximumCostUsd: Math.round(Math.min(VFX_001.hardCapUsd, first * maxPaidAttempts) * 100) / 100,
    reuse:
      "Identidad = sha256 del origen + proveedor + modelo + video_edit + prompt + negativo + rango/duración + 9:16 + 720p + SDR + controles + intensidad + estilo. " +
      "El resultado se guarda en `${requestId}/paid/<key>.mp4` (sha256 verificado); cualquier reintento lo reutiliza con 0 llamadas. El file_id de Luma se reutiliza por sha256.",
    onFailure: [
      "Subida del origen fallida (Files API): sin fila de ledger y sin costo; se puede repetir.",
      "Rechazo antes de aceptar (4xx/validación/moderación): fila REFUNDED, sin reintento automático; nuevo intento solo con nueva autorización.",
      "Fallo incierto (red cortada tras enviar): RECONCILIATION_REQUIRED, ninguna nueva llamada hasta conciliar.",
      "Generación aceptada y fallo al sondear/descargar: PROVIDER_JOB_RECORDED → se reanuda esa misma generación, nunca se reenvía.",
      "Resultado de baja calidad: STOP e informe; un segundo intento (variante de prompt/controles) requiere autorización y cabe en el tope.",
    ],
    blockers,
    requiresHumanAuthorization: true,
  };
}
