import type { BeatType, Shot, ShotType } from "./types";

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
 * RC mission "LONG FORM RC FINAL HARDENING" — antes de esto, TODO
 * documental (sin importar tema/duración/elección del usuario) usaba el
 * mismo ciclo fijo de arriba: no existía ninguna forma de que un usuario
 * decidiera cuánto contenido generativo quería, pese a que eso cambia
 * radicalmente el costo (ver production-plan.ts). `VISUAL_STRATEGIES`
 * define 3 mezclas reales, cada una un ciclo distinto de ShotType, nunca
 * un ajuste cosmético:
 *
 * - "economical": SOLO archivo/deterministico (stock/mapa/diagrama/texto/
 *   Ken Burns) — cero llamadas pagadas de imagen o video IA.
 * - "balanced": el ciclo histórico (con generated_placeholder = imagen IA,
 *   sin video IA) — comportamiento por defecto sin cambios para no romper
 *   nada que ya funcionaba.
 * - "cinematic": más proporción de imagen IA + video IA genuino en la
 *   rotación — nunca "100% IA todo el tiempo" (ver sección 11 de la
 *   misión: eso sería una opción premium aparte, no implementada todavía).
 *   Sigue siendo seguro por construcción: cada shot "ai_video" pasa igual
 *   por elegibilidad/cost-guard/fallback ya existentes en
 *   asset-resolver.ts — si se descartan, degrada a stock/imagen real,
 *   nunca genera gasto sin ese guardrail.
 */
export const VISUAL_STRATEGIES = ["economical", "balanced", "cinematic"] as const;
export type VisualStrategy = (typeof VISUAL_STRATEGIES)[number];

const STRATEGY_CYCLES: Record<VisualStrategy, ShotType[]> = {
  economical: ["stock_video", "stock_image", "ken_burns_image", "diagram", "map", "text"],
  balanced: CYCLE,
  cinematic: [
    "generated_placeholder",
    "stock_video",
    "ai_video",
    "generated_placeholder",
    "ken_burns_image",
    "stock_image",
    "ai_video",
    "diagram",
    "map",
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

export function cycleShotType(index: number, strategy: VisualStrategy = "balanced"): ShotType {
  const cycle = STRATEGY_CYCLES[strategy];
  return cycle[index % cycle.length];
}

/** Split a beat into 3–8s shots. Never returns a single image for the beat. Default strategy ("balanced") preserves the exact behavior this had before VisualStrategy existed. */
export function shotsForSpan(input: {
  beatId: string;
  beatType: BeatType;
  startSec: number;
  endSec: number;
  narration: string;
  typeOffset?: number;
  strategy?: VisualStrategy;
}): Shot[] {
  const span = input.endSec - input.startSec;
  if (!(span > 0)) throw new Error(`Beat ${input.beatId} has non-positive span`);
  let count = Math.max(2, Math.round(span / 4));
  while (span / count > MAX_HOLD) count += 1;
  while (count > 2 && span / count < MIN_HOLD) count -= 1;
  const hold = span / count;
  if (hold < MIN_HOLD - 0.05 || hold > MAX_HOLD + 0.05) {
    throw new Error(`Beat ${input.beatId} span ${span}s cannot be split into ${MIN_HOLD}-${MAX_HOLD}s shots`);
  }
  const shots: Shot[] = [];
  for (let i = 0; i < count; i++) {
    const start = input.startSec + i * hold;
    const end = i === count - 1 ? input.endSec : input.startSec + (i + 1) * hold;
    const shotType = cycleShotType(i + (input.typeOffset ?? 0), input.strategy ?? "balanced");
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
