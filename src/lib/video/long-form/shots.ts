import type { BeatType, Shot, ShotType } from "./types";

const MIN_HOLD = 3;
const MAX_HOLD = 8;

const CYCLE: ShotType[] = [
  "text",
  "generated_placeholder",
  "ken_burns_image",
  "diagram",
  "map",
  "stock_image",
  "stock_video",
];

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

export function cycleShotType(index: number): ShotType {
  return CYCLE[index % CYCLE.length];
}

/** Split a beat into 3–8s shots. Never returns a single image for the beat. */
export function shotsForSpan(input: {
  beatId: string;
  beatType: BeatType;
  startSec: number;
  endSec: number;
  narration: string;
  typeOffset?: number;
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
    const shotType = cycleShotType(i + (input.typeOffset ?? 0));
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
