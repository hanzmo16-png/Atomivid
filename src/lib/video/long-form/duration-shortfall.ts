/**
 * «El video termina mucho antes de lo pedido» (END GAME, línea B).
 *
 * El guionista ya corrige y rechaza guiones fuera de ±15 % / ±25 %
 * (duration-budget.ts), pero un guion aceptado antes de esa regla, pegado
 * por el usuario o recortado después podía llegar al worker con una
 * narración muy por debajo de la duración pedida: se producía y entregaba
 * en silencio un video corto. Estas puertas, puras y sin dependencias de
 * servidor, cierran ese hueco con la MISMA tolerancia dura del guion:
 *
 * 1. Antes de cualquier paso pagado: duración ESTIMADA por palabras.
 * 2. Antes de imágenes, música y render: duración MEDIDA de la narración.
 * 3. Después del render: duración medida del MP4 contra la compuesta.
 */
import { countWords, evaluateNarrationDuration, LONG_FORM_DURATION_HARD_TOLERANCE } from "./duration-budget";

/** Por debajo de esta fracción de lo pedido (75 %, el −25 % duro del guion) no se produce ni se entrega. */
export const LONG_FORM_MIN_DURATION_RATIO = 1 - LONG_FORM_DURATION_HARD_TOLERANCE;

/** Diferencia máxima aceptada entre el MP4 medido y la duración compuesta: max(2 s, 0.5 %). */
export function renderedDurationToleranceSeconds(composedSeconds: number): number {
  return Math.max(2, composedSeconds * 0.005);
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

export type DurationShortfallStage = "script" | "narration";

/**
 * Parada con mensaje seguro para el cliente (run-job.ts lo muestra tal cual vía
 * isCustomerSafeError). Repetir no lo resuelve: el guion necesita más narración.
 */
export class LongFormDurationShortfallError extends Error {
  readonly customerMessage: string;
  constructor(
    readonly stage: DurationShortfallStage,
    readonly requestedSeconds: number,
    readonly actualSeconds: number,
  ) {
    const what = stage === "script" ? "El guion de este documental se narraría en" : "La narración de este documental dura";
    const spent = stage === "script"
      ? "No se llamó a ningún proveedor de pago."
      : "No se generaron imágenes, música ni render; la narración ya generada queda guardada y se reutiliza.";
    const message =
      `${what} ~${clock(actualSeconds)}, muy por debajo de los ${clock(requestedSeconds)} pedidos ` +
      `(mínimo aceptado: ${Math.round(LONG_FORM_MIN_DURATION_RATIO * 100)} %). No se entregó un video más corto de lo pedido. ${spent} ` +
      "Amplía el guion o pide una duración menor antes de volver a producirlo.";
    super(message);
    this.name = "LongFormDurationShortfallError";
    this.customerMessage = message;
  }
}

/** La duración a comparar: la pedida por el usuario; sin ella (planes antiguos) no hay puerta. */
function requested(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Puerta 1 (USD 0): narración estimada por palabras (ritmo calibrado de Long Form). */
export function assertScriptCoversRequestedDuration(beats: { narration: string }[], requestedSeconds: number | null | undefined): void {
  const target = requested(requestedSeconds);
  if (target === null) return;
  const words = beats.reduce((sum, b) => sum + countWords(b.narration), 0);
  const evaluation = evaluateNarrationDuration(words, target);
  if (evaluation.ratio < LONG_FORM_MIN_DURATION_RATIO) {
    throw new LongFormDurationShortfallError("script", target, evaluation.estimatedSeconds);
  }
}

/** Puerta 2: narración MEDIDA (línea de tiempo real), antes de imágenes, música y render. */
export function assertNarrationCoversRequestedDuration(measuredSeconds: number, requestedSeconds: number | null | undefined): void {
  const target = requested(requestedSeconds);
  if (target === null) return;
  if (!Number.isFinite(measuredSeconds) || measuredSeconds / target < LONG_FORM_MIN_DURATION_RATIO) {
    throw new LongFormDurationShortfallError("narration", target, Number.isFinite(measuredSeconds) ? measuredSeconds : 0);
  }
}

/** Puerta 3: ¿el MP4 medido dura lo que se compuso? */
export function renderedDurationMismatch(measuredSeconds: number, composedSeconds: number): { measuredSeconds: number; composedSeconds: number; toleranceSeconds: number } | null {
  const toleranceSeconds = renderedDurationToleranceSeconds(composedSeconds);
  if (Number.isFinite(measuredSeconds) && measuredSeconds > 0 && Math.abs(measuredSeconds - composedSeconds) <= toleranceSeconds) return null;
  return { measuredSeconds, composedSeconds, toleranceSeconds };
}

/** El MP4 renderizado no dura lo compuesto: no se sube ni se marca completado. «Reintentar» re-renderiza reutilizando lo pagado. */
export class LongFormRenderedDurationError extends Error {
  readonly customerMessage: string;
  constructor(readonly measuredSeconds: number, readonly composedSeconds: number) {
    const message =
      `El archivo renderizado dura ${clock(measuredSeconds)} en lugar de los ${clock(composedSeconds)} compuestos, así que no se entregó. ` +
      "La narración y las escenas ya generadas quedan guardadas: «Reintentar» vuelve a renderizar sin repetir los pasos ya pagados.";
    super(message);
    this.name = "LongFormRenderedDurationError";
    this.customerMessage = message;
  }
}
