/**
 * Formato de presentación PURO (sin DOM, sin fetch) de la respuesta de
 * `POST /api/long-form/visual-test-v2/real` — mismo principio que
 * visual-test-v2-display.ts (el del DRY_RUN): copia EXPLÍCITAMENTE solo
 * los campos esperados y conocidos-seguros, nunca un passthrough genérico
 * del body, para que un campo inesperado nunca llegue a mostrarse.
 */

const SAFE_GENERIC_ERROR = "No se pudo completar la generación. Intenta de nuevo en un momento.";

export type RealRunShotDisplay = {
  shotId: string;
  status: "reused" | "generated" | "unknown";
  costUsd: number;
  storagePath: string;
};

export type RealRunDisplayState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; httpStatus: number; message: string }
  | {
      kind: "result";
      httpStatus: 200;
      shots: RealRunShotDisplay[];
      totalSpentThisRunUsd: number;
      ledgerTotalSpentUsd: number;
      ledgerVisualTestV2SpentUsd: number;
      maxTotalUsd: number;
      hardStopUsd: number;
      paidApisCalled: boolean;
    };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readShots(value: unknown): RealRunShotDisplay[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const shot = (entry ?? {}) as Record<string, unknown>;
    const status = shot.status === "reused" || shot.status === "generated" ? shot.status : "unknown";
    return {
      shotId: readString(shot.shotId) ?? "?",
      status,
      costUsd: readNumber(shot.costUsd),
      storagePath: readString(shot.storagePath) ?? "",
    };
  });
}

/** Convierte (status HTTP, body ya parseado como JSON) en un estado de UI listo para renderizar. Nunca lanza. */
export function summarizeRealRunResponse(httpStatus: number, body: unknown): RealRunDisplayState {
  if (httpStatus !== 200) {
    const errorField = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
    return { kind: "error", httpStatus, message: readString(errorField) ?? SAFE_GENERIC_ERROR };
  }

  if (typeof body !== "object" || body === null) {
    return { kind: "error", httpStatus, message: SAFE_GENERIC_ERROR };
  }

  const b = body as Record<string, unknown>;
  return {
    kind: "result",
    httpStatus: 200,
    shots: readShots(b.shots),
    totalSpentThisRunUsd: readNumber(b.totalSpentThisRunUsd),
    ledgerTotalSpentUsd: readNumber(b.ledgerTotalSpentUsd),
    ledgerVisualTestV2SpentUsd: readNumber(b.ledgerVisualTestV2SpentUsd),
    maxTotalUsd: readNumber(b.maxTotalUsd),
    hardStopUsd: readNumber(b.hardStopUsd),
    paidApisCalled: Boolean(b.paidApisCalled),
  };
}
