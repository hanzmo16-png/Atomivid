/**
 * Formato de presentación PURO (sin DOM, sin fetch) de la respuesta de
 * `POST /api/long-form/visual-test-v2` para la UI administrativa mínima y
 * temporal (ver DryRunButton.tsx). Separado del componente "use client"
 * para poder probarlo con node:test sin necesitar un DOM/React Testing
 * Library — mismo criterio de "lógica pura extraída y testeable" que el
 * resto del proyecto (p. ej. evaluateRenderStart en render-guard.ts).
 *
 * Copia EXPLÍCITAMENTE solo los campos esperados y conocidos-seguros del
 * body de la respuesta — nunca hace un passthrough genérico del objeto
 * completo. Esto es una defensa adicional (nunca la única: el propio
 * endpoint ya nunca incluye secretos — ver visual-test-v2-runtime.test.ts)
 * para que, aunque el backend cambiara algún día e incluyera un campo
 * inesperado, la UI nunca lo muestre sin que alguien decida
 * explícitamente añadirlo aquí.
 */

const SAFE_GENERIC_ERROR = "No se pudo completar el Dry Run. Intenta de nuevo en un momento.";

export type DryRunShotDisplay = {
  shotId: string;
  wouldGenerate: boolean;
  estimatedCostUsd: number;
};

export type DryRunDisplayState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; httpStatus: number; message: string }
  | {
      kind: "report";
      httpStatus: 200;
      openaiApiKeyAvailable: boolean;
      shots: DryRunShotDisplay[];
      estimatedTotalUsd: number;
      maxTotalUsd: number;
      hardStopUsd: number;
      withinCostGuard: boolean;
      costGuardBlockReason?: string;
      realModeLocked: boolean;
      paidApisCalled: boolean;
    };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readShots(value: unknown): DryRunShotDisplay[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const shot = (entry ?? {}) as Record<string, unknown>;
    return {
      shotId: readString(shot.shotId) ?? "?",
      wouldGenerate: Boolean(shot.wouldGenerate),
      estimatedCostUsd: readNumber(shot.estimatedCostUsd),
    };
  });
}

/**
 * Convierte (status HTTP, body ya parseado como JSON) en un estado de UI
 * listo para renderizar. Nunca lanza — cualquier forma inesperada del
 * body se trata como un error genérico y seguro, nunca como un crash de
 * la página.
 */
export function summarizeDryRunResponse(httpStatus: number, body: unknown): DryRunDisplayState {
  if (httpStatus !== 200) {
    const errorField = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
    return { kind: "error", httpStatus, message: readString(errorField) ?? SAFE_GENERIC_ERROR };
  }

  if (typeof body !== "object" || body === null) {
    return { kind: "error", httpStatus, message: SAFE_GENERIC_ERROR };
  }

  const b = body as Record<string, unknown>;
  const costGuardBlockReason = readString(b.costGuardBlockReason);

  return {
    kind: "report",
    httpStatus: 200,
    openaiApiKeyAvailable: Boolean(b.openaiApiKeyAvailable),
    shots: readShots(b.shots),
    estimatedTotalUsd: readNumber(b.estimatedTotalUsd),
    maxTotalUsd: readNumber(b.maxTotalUsd),
    hardStopUsd: readNumber(b.hardStopUsd),
    withinCostGuard: Boolean(b.withinCostGuard),
    ...(costGuardBlockReason ? { costGuardBlockReason } : {}),
    realModeLocked: Boolean(b.realModeLocked),
    paidApisCalled: Boolean(b.paidApisCalled),
  };
}
