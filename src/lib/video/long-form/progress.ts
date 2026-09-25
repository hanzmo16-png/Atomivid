/**
 * RC mission "LONG FORM RC FINAL HARDENING" — progreso REAL, no una
 * pantalla fija de "Preparando tu video..." durante minutos. Reutiliza el
 * vocabulario de etapas YA existente (LONG_FORM_STAGES, stages.ts) — no es
 * otra state machine paralela, solo le añade unidades de trabajo reales
 * (p. ej. "7/14 escenas") dentro de la etapa "assets", la más larga y la
 * única con trabajo por-shot real que vale la pena contar.
 *
 * `computeProductionProgress()` es puro/determinístico/monotónico: el
 * porcentaje solo depende de en qué etapa está (orden fijo del pipeline,
 * nunca retrocede) y de units_completed/units_total DENTRO de esa etapa
 * (que tampoco retrocede — produce.ts solo incrementa). Los rangos por
 * etapa de abajo son estimaciones editoriales explícitas (proporción
 * relativa de tiempo real observado en el pipeline), nunca una medición
 * exacta — de ahí que el ETA (ver estimateRemainingSeconds) siempre se
 * muestre como rango, nunca con falsa precisión de segundos exactos.
 */
import { LONG_FORM_STAGES, type LongFormStage } from "./stages";

export type ProgressStageKey = "queued" | LongFormStage | "uploading";

const STAGE_ORDER: ProgressStageKey[] = ["queued", ...LONG_FORM_STAGES, "uploading"];

/** [inicio%, fin%] de cada etapa — deben cubrir 0-100 sin huecos ni solapes, en el mismo orden que STAGE_ORDER. */
const STAGE_WEIGHTS: Record<ProgressStageKey, readonly [number, number]> = {
  queued: [0, 3],
  scripting: [3, 10],
  storyboard: [10, 18],
  assets: [18, 78],
  ai_video: [78, 88],
  rendering: [88, 97],
  uploading: [97, 100],
};

export type LongFormProgress = {
  stage: ProgressStageKey;
  unitsCompleted: number;
  unitsTotal: number;
  unitLabel: string;
  updatedAt: string;
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 0-100, entero, monotónico dentro del orden fijo de etapas — nunca inventa progreso, nunca retrocede si se le sigue pasando el mismo pipeline en orden. */
export function computeProductionProgress(input: Pick<LongFormProgress, "stage" | "unitsCompleted" | "unitsTotal">): number {
  const [start, end] = STAGE_WEIGHTS[input.stage] ?? [0, 0];
  if (input.unitsTotal <= 0) return Math.round(start);
  const within = clamp01(input.unitsCompleted / input.unitsTotal);
  return Math.round(start + within * (end - start));
}

export function isTerminalStage(stage: ProgressStageKey | "completed" | "failed"): boolean {
  return stage === "completed" || stage === "failed";
}

/** Etapas ya completadas (para el checklist ✓/●/○ — ver ProductionProgressCard) — estrictamente las que preceden a `stage` en STAGE_ORDER. */
export function completedStages(stage: ProgressStageKey): ProgressStageKey[] {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx <= 0 ? [] : STAGE_ORDER.slice(0, idx);
}

export function isProgressStageKey(value: unknown): value is ProgressStageKey {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}

/** Valida la forma real de long_form_progress (JSONB, migración 0019) antes de usarla — nunca se confía en el contenido crudo de la columna. */
export function isLongFormProgress(value: unknown): value is LongFormProgress {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LongFormProgress>;
  return (
    isProgressStageKey(v.stage) &&
    typeof v.unitsCompleted === "number" &&
    typeof v.unitsTotal === "number" &&
    typeof v.unitLabel === "string" &&
    typeof v.updatedAt === "string"
  );
}

/**
 * Segundos/unidad ESTIMADOS por etapa — nunca datos históricos reales
 * (todavía no existe telemetría persistida por video, ver sección 33 de
 * la misión: eso queda preparado para una fase futura). Deliberadamente
 * conservador/amplio: el ETA que se muestra siempre es un RANGO (ver
 * estimateRemainingRangeSeconds), nunca un conteo regresivo exacto.
 */
const SECONDS_PER_UNIT_LOW: Partial<Record<ProgressStageKey, number>> = {
  assets: 8,
  ai_video: 25,
};
const SECONDS_PER_UNIT_HIGH: Partial<Record<ProgressStageKey, number>> = {
  assets: 20,
  ai_video: 70,
};
/** Piso/techo genérico para cualquier etapa sin trabajo por-unidad medible (scripting/storyboard/rendering/uploading) — ancho a propósito. */
const GENERIC_STAGE_RANGE_SECONDS: readonly [number, number] = [15, 90];

/**
 * Rango de segundos restantes — SOLO a partir de trabajo pendiente real
 * (unidades restantes de la etapa actual + un rango genérico por cada
 * etapa futura todavía no alcanzada). Nunca cuenta regresiva de reloj:
 * si no hay evidencia suficiente (unitsTotal desconocido y no quedan
 * etapas futuras estimables), devuelve `null` — el caller debe mostrar
 * "Calculando tiempo restante..." en vez de inventar un número.
 */
export function estimateRemainingRangeSeconds(input: Pick<LongFormProgress, "stage" | "unitsCompleted" | "unitsTotal">): [number, number] | null {
  if (isTerminalStage(input.stage as never)) return null;
  const idx = STAGE_ORDER.indexOf(input.stage);
  if (idx === -1) return null;

  let low = 0;
  let high = 0;
  let hasEvidence = false;

  const remainingUnits = Math.max(0, input.unitsTotal - input.unitsCompleted);
  const lowRate = SECONDS_PER_UNIT_LOW[input.stage];
  const highRate = SECONDS_PER_UNIT_HIGH[input.stage];
  if (input.unitsTotal > 0 && lowRate !== undefined && highRate !== undefined) {
    low += remainingUnits * lowRate;
    high += remainingUnits * highRate;
    hasEvidence = true;
  } else {
    low += GENERIC_STAGE_RANGE_SECONDS[0];
    high += GENERIC_STAGE_RANGE_SECONDS[1];
    hasEvidence = true;
  }

  for (const futureStage of STAGE_ORDER.slice(idx + 1)) {
    if (futureStage === "ai_video") continue; // opcional — no todo documental tiene shots ai_video, no se cuenta como pendiente garantizado.
    low += GENERIC_STAGE_RANGE_SECONDS[0];
    high += GENERIC_STAGE_RANGE_SECONDS[1];
  }

  return hasEvidence ? [Math.round(low), Math.round(high)] : null;
}

export function formatRemainingRange(range: [number, number] | null): string {
  if (!range) return "Calculando tiempo restante…";
  const [lowSec, highSec] = range;
  const lowMin = Math.max(1, Math.round(lowSec / 60));
  const highMin = Math.max(lowMin, Math.round(highSec / 60));
  if (lowMin === highMin) return `Tiempo restante estimado: ~${lowMin} min`;
  return `Tiempo restante estimado: ${lowMin}–${highMin} min`;
}
