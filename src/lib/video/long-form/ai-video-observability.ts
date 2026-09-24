/**
 * Observabilidad del AI Video Pipeline (P1 devolvía outcomes tipados pero
 * nunca los persistía/logueaba — P2A construye esa capa). Registra
 * EXACTAMENTE los campos pedidos en el encargo: provider, model,
 * benchmarkId, shotId, providerJobId, executionMode, generationTime,
 * clipDuration, estimatedCost, actualCost, retryCount, failureReason,
 * fallbackUsed, validationResult.
 *
 * Nunca incluye el prompt/texto de la escena ni ningún secreto/token — solo
 * metadata de ejecución, mismo criterio que runway.ts (nunca loguea la URL
 * firmada del resultado ni el token de la tarea). `assertNoSecretLeakage`
 * es una defensa explícita: falla si alguna clave del registro se parece a
 * un secreto, para que un futuro campo agregado por error no se cuele.
 */

export type AiVideoObservabilityRecord = {
  provider: string;
  model: string;
  benchmarkId?: string;
  shotId: string;
  providerJobId?: string;
  executionMode: "simulation" | "real";
  generationTimeMs?: number;
  clipDurationSeconds?: number;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  retryCount: number;
  failureReason?: string;
  fallbackUsed?: string;
  validationResult: "valid" | "invalid" | "not_applicable";
  recordedAtIso: string;
};

const FORBIDDEN_KEY_SUBSTRINGS = ["apikey", "api_key", "token", "secret", "password", "authorization", "prompt"];

export class AiVideoObservabilitySecretLeakageError extends Error {
  constructor(public readonly key: string) {
    super(`AiVideoObservabilityRecord: el campo "${key}" parece contener un secreto/prompt — nunca se loguea esto, revisa el llamador.`);
    this.name = "AiVideoObservabilitySecretLeakageError";
  }
}

/** Defensa en profundidad: falla si alguna CLAVE del registro sugiere que se coló un secreto o el prompt — el TIPO ya no debería permitirlo, esto cubre un futuro campo agregado por error o un objeto construido a mano fuera del tipo. */
export function assertNoSecretLeakage(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEY_SUBSTRINGS.some((s) => lower.includes(s))) {
      throw new AiVideoObservabilitySecretLeakageError(key);
    }
  }
}

export type BuildObservabilityRecordParams = {
  provider: string;
  model: string;
  benchmarkId?: string;
  shotId: string;
  providerJobId?: string;
  executionMode: "simulation" | "real";
  generationTimeMs?: number;
  clipDurationSeconds?: number;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  retryCount?: number;
  failureReason?: string;
  fallbackUsed?: string;
  validationResult: "valid" | "invalid" | "not_applicable";
};

/** Construye un registro normalizado — pura, sin loguear nada. El llamador decide cuándo/dónde escribirlo (ver logAiVideoObservabilityRecord para la salida por consola de esta fase, sin dashboard todavía). */
export function buildAiVideoObservabilityRecord(params: BuildObservabilityRecordParams): AiVideoObservabilityRecord {
  const record: AiVideoObservabilityRecord = {
    provider: params.provider,
    model: params.model,
    benchmarkId: params.benchmarkId,
    shotId: params.shotId,
    providerJobId: params.providerJobId,
    executionMode: params.executionMode,
    generationTimeMs: params.generationTimeMs,
    clipDurationSeconds: params.clipDurationSeconds,
    estimatedCostUsd: params.estimatedCostUsd,
    actualCostUsd: params.actualCostUsd,
    retryCount: params.retryCount ?? 0,
    failureReason: params.failureReason,
    fallbackUsed: params.fallbackUsed,
    validationResult: params.validationResult,
    recordedAtIso: new Date().toISOString(),
  };
  assertNoSecretLeakage(record as unknown as Record<string, unknown>);
  return record;
}

/** Salida estructurada por consola — sin dashboard todavía (P2A), pero con forma estable para que un futuro sink (tabla/archivo) pueda parsear la misma línea. */
export function logAiVideoObservabilityRecord(record: AiVideoObservabilityRecord): void {
  console.log(`[ai-video-observability] ${JSON.stringify(record)}`);
}
