import type { BeatType, Shot, ShotMotion, ShotType } from "./types";
import type { BeatVisual } from "./visual-intents";

export const MIN_HOLD = 3;
export const MAX_HOLD = 8;

const CYCLE: ShotType[] = [
  "text",
  "generated_placeholder",
  "ken_burns_image",
  "diagram",
  "map",
  "stock_image",
  "stock_video",
];

/**
 * Estrategias visuales de la ruta de PRODUCTO (ver production-plan.ts).
 * Ningún ciclo de producto incluye "diagram"/"map": sin datos verificados
 * esos shots solo podían rellenarse con specs de fixture ("Mapa de
 * ejemplo (fixture)") — contenido falso en un video real. "text" es una
 * tarjeta REAL (tema + oración de la narración, ver visual-intents.ts).
 *
 * - "economical": solo archivo real (stock video/imagen) + tarjeta de
 *   texto — cero llamadas pagadas de imagen o video IA.
 * - "balanced": archivo real + ~1 de cada 4 shots como imagen IA; sin
 *   video IA.
 * - "cinematic": más imagen IA + ranuras de video IA (Veo image-to-video)
 *   — cada ranura pasa por elegibilidad de contenido + cost guard + el
 *   presupuesto confirmado; si no califica se degrada a imagen IA con
 *   movimiento, o a archivo. Nunca "100% video IA".
 *
 * Sin `strategy` explícita (CLI/fixtures históricos) se usa CYCLE, sin
 * cambios.
 */
export const VISUAL_STRATEGIES = ["economical", "balanced", "cinematic"] as const;
export type VisualStrategy = (typeof VISUAL_STRATEGIES)[number];

export const STRATEGY_CYCLES: Record<VisualStrategy, readonly ShotType[]> = {
  economical: ["stock_video", "stock_image", "ken_burns_image", "stock_video", "text", "ken_burns_image"],
  balanced: [
    "stock_video",
    "ken_burns_image",
    "generated_placeholder",
    "stock_image",
    "stock_video",
    "text",
    "generated_placeholder",
    "ken_burns_image",
  ],
  cinematic: [
    "generated_placeholder",
    "stock_video",
    "ai_video",
    "generated_placeholder",
    "ken_burns_image",
    "text",
    "generated_placeholder",
    "stock_video",
    "ai_video",
  ],
};

export function isVisualStrategy(value: unknown): value is VisualStrategy {
  return typeof value === "string" && (VISUAL_STRATEGIES as readonly string[]).includes(value);
}

export function assertShotHolds(shots: Shot[]): void {
  for (const shot of shots) {
    if (shot.durationSec < MIN_HOLD - 0.05 || shot.durationSec > MAX_HOLD + 0.05) {
      throw new Error(`Shot ${shot.id} hold ${shot.durationSec}s outside ${MIN_HOLD}-${MAX_HOLD}s`);
    }
  }
}

export function assertBeatsHaveMultipleShots(
  beats: { id: string; shots: Shot[] }[],
  minShots = 2,
): void {
  for (const beat of beats) {
    if (beat.shots.length < minShots) {
      throw new Error(`Beat ${beat.id} has ${beat.shots.length} shots; need >= ${minShots}`);
    }
  }
}

export function dedupKeys(shots: Shot[]): string[] {
  return shots.map((s) => s.dedupKey);
}

export function cycleShotType(index: number, strategy?: VisualStrategy): ShotType {
  const cycle = strategy ? STRATEGY_CYCLES[strategy] : CYCLE;
  return cycle[index % cycle.length];
}

function productMotion(type: ShotType): ShotMotion {
  if (type === "stock_video") return "pan";
  if (type === "ken_burns_image" || type === "generated_placeholder" || type === "stock_image") return "ken_burns";
  return "static";
}

/**
 * Split a beat into 3–8s shots. Never returns a single image for the beat.
 * Sin `visuals`/`strategy` (CLI/fixtures) conserva exactamente el
 * comportamiento histórico; la ruta de producto siempre pasa ambos.
 */
export function shotsForSpan(input: {
  beatId: string;
  beatType: BeatType;
  startSec: number;
  endSec: number;
  narration: string;
  typeOffset?: number;
  strategy?: VisualStrategy;
  /** Intenciones visuales REALES del beat (ver visual-intents.ts) — rotan entre sus shots. */
  visuals?: BeatVisual[];
  /**
   * Número de escenas CONFIRMADO en el plan para este beat. Se respeta si la
   * duración real lo permite (cada escena entre MIN_HOLD y MAX_HOLD); si no,
   * se usa el reparto por defecto (y el worker registra la desviación).
   */
  targetCount?: number;
}): Shot[] {
  const span = input.endSec - input.startSec;
  if (!(span > 0)) throw new Error(`Beat ${input.beatId} has non-positive span`);
  let count = Math.max(2, Math.round(span / 4));
  while (span / count > MAX_HOLD) count += 1;
  while (count > 2 && span / count < MIN_HOLD) count -= 1;
  const target = input.targetCount;
  if (target !== undefined && Number.isInteger(target) && target >= 2 && span / target >= MIN_HOLD && span / target <= MAX_HOLD) {
    count = target;
  }
  const hold = span / count;
  if (hold < MIN_HOLD - 0.05 || hold > MAX_HOLD + 0.05) {
    throw new Error(`Beat ${input.beatId} span ${span}s cannot be split into ${MIN_HOLD}-${MAX_HOLD}s shots`);
  }
  const shots: Shot[] = [];
  for (let i = 0; i < count; i++) {
    const start = input.startSec + i * hold;
    const end = i === count - 1 ? input.endSec : input.startSec + (i + 1) * hold;
    const shotType = cycleShotType(i + (input.typeOffset ?? 0), input.strategy);
    const visual = input.visuals && input.visuals.length > 0 ? input.visuals[i % input.visuals.length] : undefined;
    if (visual) {
      shots.push({
        id: `${input.beatId}-shot-${i + 1}`,
        beatId: input.beatId,
        startSec: round3(start),
        endSec: round3(end),
        durationSec: round3(end - start),
        type: shotType,
        source: shotType === "text" ? "local" : shotType === "generated_placeholder" || shotType === "ai_video" ? "generated" : "stock",
        assetId: `${input.beatId}-${i}`,
        visualIntent: visual.description,
        motionRequired: visual.motion || undefined,
        motion: productMotion(shotType),
        captionText: input.narration,
        license: "resolved-at-execution",
        attribution: "",
        dedupKey: `${input.beatId}:${shotType}:${i}`,
        status: "planned",
        validationStatus: "pending",
      });
      continue;
    }
    shots.push({
      id: `${input.beatId}-shot-${i + 1}`,
      beatId: input.beatId,
      startSec: round3(start),
      endSec: round3(end),
      durationSec: round3(end - start),
      type: shotType,
      source: "fixture",
      assetId: `fixture-${shotType}-${i}`,
      visualIntent: `${shotType} for ${input.beatType}`,
      motion: shotType === "ken_burns_image" ? "ken_burns" : shotType === "stock_video" ? "pan" : "static",
      overlay:
        shotType === "text" || shotType === "diagram" || shotType === "map"
          ? input.beatType.toUpperCase()
          : undefined,
      captionText: input.narration,
      license: "fixture-internal",
      attribution: "ATOMIVID Long Form fixture",
      dedupKey: `${input.beatId}:${shotType}:${i}`,
      status: "planned",
      validationStatus: "pending",
    });
  }
  return shots;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
