import type { WordTiming } from "@/lib/providers/types";
import type { BeatType, Shot, ShotMotion, ShotType } from "./types";
import type { BeatVisual } from "./visual-intents";
import { anchorIntents, fragmentForRange, narrationWords, salientFact, wordRangesForShots } from "./scene-anchoring";

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
  /**
   * Planes v3+: cada escena se ancla al pasaje narrado durante ella (ver
   * scene-anchoring.ts) en vez de reciclar `visuals[i % n]`. `words` =
   * tiempos reales por palabra RELATIVOS al inicio del beat (sin ellos, el
   * reparto se estima por posición). Ausente = comportamiento histórico.
   */
  anchoring?: { words?: WordTiming[] };
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
  if (input.anchoring && input.visuals && input.visuals.length > 0) {
    return anchoredShots(input as Required<Pick<typeof input, "visuals" | "anchoring">> & typeof input, count, hold);
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

/**
 * Escenas ancladas a la narración: intención por pasaje (nunca por módulo),
 * fragmento narrado propio, y tarjeta de texto SOLO donde el pasaje trae un
 * dato destacable (año/cifra); en otro caso esa ranura pasa a imagen.
 */
function anchoredShots(
  input: Parameters<typeof shotsForSpan>[0] & { visuals: BeatVisual[]; anchoring: { words?: WordTiming[] } },
  count: number,
  hold: number,
): Shot[] {
  const spans = Array.from({ length: count }, (_, i) => ({
    startSec: input.startSec + i * hold,
    endSec: i === count - 1 ? input.endSec : input.startSec + (i + 1) * hold,
  }));
  const words = input.anchoring.words;
  const ranges = wordRangesForShots(spans, input.startSec, input.endSec, input.narration, words);
  // Los tiempos por palabra del TTS pueden tokenizar distinto que la
  // narración: los índices se llevan al espacio de palabras de la narración.
  const narrationCount = narrationWords(input.narration).length;
  const tokenCount = words && words.length > 0 ? words.length : narrationCount;
  const scale = tokenCount > 0 ? narrationCount / tokenCount : 1;
  const narrationRanges = ranges.map((r) => ({ first: Math.floor(r.first * scale), last: Math.floor(r.last * scale) }));
  const intents = anchorIntents(narrationRanges, input.narration, input.visuals);
  return spans.map((span, i) => {
    const fragment = fragmentForRange(input.narration, ranges[i], words) || input.narration;
    const intent = intents[i];
    let shotType = cycleShotType(i + (input.typeOffset ?? 0), input.strategy);
    if ((shotType === "text" || shotType === "diagram" || shotType === "map") && !salientFact(fragment)) shotType = "ken_burns_image";
    return {
      id: `${input.beatId}-shot-${i + 1}`,
      beatId: input.beatId,
      startSec: round3(span.startSec),
      endSec: round3(span.endSec),
      durationSec: round3(span.endSec - span.startSec),
      type: shotType,
      source: shotType === "text" ? "local" : shotType === "generated_placeholder" || shotType === "ai_video" ? "generated" : "stock",
      assetId: `${input.beatId}-${i}`,
      visualIntent: intent.visual.description,
      motionRequired: intent.visual.motion || undefined,
      motion: productMotion(shotType),
      captionText: fragment,
      narrationFragment: fragment,
      anchoredVisual: intent.visual,
      intentAnchor: { visualIndex: intent.visualIndex, reuseIndex: intent.reuseIndex, anchoredBy: intent.anchoredBy },
      license: "resolved-at-execution",
      attribution: "",
      dedupKey: `${input.beatId}:${shotType}:${i}`,
      status: "planned",
      validationStatus: "pending",
    } satisfies Shot;
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
