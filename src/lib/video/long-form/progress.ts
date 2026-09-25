/**
 * Progreso REAL de una producción de Long Form. Reutiliza el vocabulario
 * de etapas existente (LONG_FORM_STAGES) — no es otra state machine — y
 * añade unidades de trabajo reales dentro de la etapa: narraciones
 * sintetizadas (storyboard), escenas resueltas (assets), fotogramas
 * renderizados (rendering).
 *
 * `computeProductionProgress()` es puro y monotónico sobre el orden fijo
 * del pipeline. Los rangos por etapa son una partición editorial explícita
 * (no una medición); el porcentaje dentro de la etapa sí es trabajo real.
 * "ai_video" ya no es una fase aparte (los clips se resuelven dentro de
 * "assets") y conserva un rango de ancho cero solo por compatibilidad con
 * filas antiguas.
 *
 * ETA: SOLO a partir del ritmo observado en la etapa actual (unidades
 * completadas / tiempo transcurrido desde stageStartedAt). Sin evidencia
 * suficiente → null ("Calculando tiempo restante…"). Nunca una constante
 * inventada ni una cuenta regresiva. `history` queda reservado para
 * telemetría histórica real cuando exista.
 */
import { LONG_FORM_STAGES, type LongFormStage } from "./stages";

export type ProgressStageKey = "queued" | LongFormStage | "uploading";

const STAGE_ORDER: ProgressStageKey[] = ["queued", ...LONG_FORM_STAGES, "uploading"];

/** [inicio%, fin%] por etapa — cubren 0-100 sin huecos ni solapes, en el orden de STAGE_ORDER. */
const STAGE_WEIGHTS: Record<ProgressStageKey, readonly [number, number]> = {
  queued: [0, 2],
  scripting: [2, 4],
  storyboard: [4, 14],
  assets: [14, 72],
  ai_video: [72, 72],
  rendering: [72, 97],
  uploading: [97, 100],
};

/** Etapas visibles en el checklist (las que realmente ocurren como fase propia). */
export const VISIBLE_PROGRESS_STAGES: LongFormStage[] = LONG_FORM_STAGES.filter((s) => s !== "ai_video");

export type LongFormProgress = {
  stage: ProgressStageKey;
  unitsCompleted: number;
  unitsTotal: number;
  unitLabel: string;
  /** Último latido del worker. */
  updatedAt: string;
  /** Cuándo empezó la etapa actual (para el ritmo observado). */
  stageStartedAt?: string;
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 0-100, entero, monotónico en el orden fijo de etapas. Nunca 100 mientras la solicitud sigue "processing". */
export function computeProductionProgress(input: Pick<LongFormProgress, "stage" | "unitsCompleted" | "unitsTotal">): number {
  const [start, end] = STAGE_WEIGHTS[input.stage] ?? [0, 0];
  if (input.unitsTotal <= 0) return Math.round(start);
  const within = clamp01(input.unitsCompleted / input.unitsTotal);
  return Math.min(99, Math.round(start + within * (end - start)));
}

/**
 * Nunca retrocede lo ya mostrado: si llega un valor menor (p. ej. un
 * fallback aumentó unitsTotal), se conserva el previo.
 */
export function nextDisplayedProgress(previous: number | null, next: number): number {
  return previous === null ? next : Math.max(previous, next);
}

export function isTerminalStage(stage: ProgressStageKey | "completed" | "failed"): boolean {
  return stage === "completed" || stage === "failed";
}

/** Etapas estrictamente anteriores a `stage` en el orden del pipeline. */
export function completedStages(stage: ProgressStageKey): ProgressStageKey[] {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx <= 0 ? [] : STAGE_ORDER.slice(0, idx);
}

export function isProgressStageKey(value: unknown): value is ProgressStageKey {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}

/** Valida la forma real de long_form_progress (JSONB) antes de usarla. */
export function isLongFormProgress(value: unknown): value is LongFormProgress {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LongFormProgress>;
  return (
    isProgressStageKey(v.stage) &&
    typeof v.unitsCompleted === "number" &&
    typeof v.unitsTotal === "number" &&
    typeof v.unitLabel === "string" &&
    typeof v.updatedAt === "string" &&
    (v.stageStartedAt === undefined || typeof v.stageStartedAt === "string")
  );
}

/** Mínimo de unidades completadas antes de extrapolar un ritmo. */
export const MIN_UNITS_FOR_ETA = 3;

/**
 * Rango [bajo, alto] de segundos restantes DE LA ETAPA ACTUAL, derivado
 * solo del ritmo observado. null si no hay evidencia suficiente.
 * `history` (telemetría histórica real) queda reservado — hoy no existe.
 */
export function estimateRemainingRangeSeconds(
  input: Pick<LongFormProgress, "stage" | "unitsCompleted" | "unitsTotal"> & { stageStartedAt?: string; updatedAt?: string },
  nowMs: number,
  history?: { medianSecondsPerUnit?: Partial<Record<ProgressStageKey, number>> },
): [number, number] | null {
  void history;
  if (!input.stageStartedAt || input.unitsTotal <= 0 || input.unitsCompleted < MIN_UNITS_FOR_ETA) return null;
  const startedMs = Date.parse(input.stageStartedAt);
  const observedAtMs = input.updatedAt ? Date.parse(input.updatedAt) : nowMs;
  if (!Number.isFinite(startedMs) || !Number.isFinite(observedAtMs) || observedAtMs <= startedMs) return null;
  const remainingUnits = Math.max(0, input.unitsTotal - input.unitsCompleted);
  if (remainingUnits === 0) return null;
  const secondsPerUnit = (observedAtMs - startedMs) / 1000 / input.unitsCompleted;
  const center = remainingUnits * secondsPerUnit;
  return [Math.round(center * 0.8), Math.round(center * 1.5)];
}

export function formatRemainingRange(range: [number, number] | null): string {
  if (!range) return "Calculando tiempo restante…";
  const [lowSec, highSec] = range;
  const lowMin = Math.max(1, Math.round(lowSec / 60));
  const highMin = Math.max(lowMin, Math.round(highSec / 60));
  if (lowMin === highMin) return `Tiempo restante de esta etapa: ~${lowMin} min`;
  return `Tiempo restante de esta etapa: ${lowMin}–${highMin} min`;
}
