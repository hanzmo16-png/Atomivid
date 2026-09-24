/**
 * Registro de evaluación PROVIDER-INDEPENDIENTE para un resultado (real o
 * simulado) del Benchmark Suite de video-IA (P2A) — la ESTRUCTURA para
 * poder comparar Runway/Luma/Veo/etc. sobre los mismos criterios más
 * adelante. No automatiza ninguna puntuación subjetiva todavía (motionQuality,
 * historicalPlausibility, etc. se llenan a mano por un humano revisando el
 * clip) — solo garantiza que TODOS los resultados, sin importar el
 * proveedor, se almacenan con la misma forma, para poder compararlos.
 *
 * Invariante de seguridad histórica: nunca se marca `usableInFinalEdit:
 * true` en un registro con `generationSuccess: false` (nada generado no
 * puede ser "usable"), y `assertEvaluationRecordNeverFakesReal` garantiza
 * que un registro con `executionMode: "real"` nunca pueda venir del
 * proveedor fixture — mismo criterio que AiVideoProductionFixtureError en
 * ai-video-resolver.ts, aplicado aquí a la capa de evaluación.
 */
import type { BenchmarkEvaluationCriterion } from "./ai-video-benchmark-manifest";

export type AiVideoExecutionMode = "simulation" | "real";

/** 0 (no cumple) a 5 (excelente) — escala fija para que las puntuaciones de distintos evaluadores/proveedores sean comparables. Ninguna se calcula automáticamente en P2A. */
export type SubjectiveScore = 0 | 1 | 2 | 3 | 4 | 5;

export type AiVideoEvaluationRecord = {
  benchmarkId: string;
  shotId: string;
  provider: string;
  model: string;
  executionMode: AiVideoExecutionMode;
  evaluatedAtIso: string;

  // --- Resultado objetivo de la generación ---
  generationSuccess: boolean;
  generationTimeSeconds?: number;
  costUsd?: number;
  durationSeconds?: number;
  resolution?: { widthPx: number; heightPx: number };

  // --- Evaluación subjetiva (llenado manual, ver evaluationCriteria del shot en el manifest) ---
  historicalPlausibility?: SubjectiveScore;
  promptAdherence?: SubjectiveScore;
  motionQuality?: SubjectiveScore;
  temporalConsistency?: SubjectiveScore;
  humanAnatomyQuality?: SubjectiveScore;
  physicalPlausibility?: SubjectiveScore;
  visualArtifacts?: SubjectiveScore;
  referenceConsistency?: SubjectiveScore;
  usableInFinalEdit?: boolean;
  notes?: string;
};

/** Crea un registro PENDIENTE (sin generar todavía) — el punto de partida antes de cualquier generación real o simulada. */
export function createPendingEvaluationRecord(params: {
  benchmarkId: string;
  shotId: string;
  provider: string;
  model: string;
  executionMode: AiVideoExecutionMode;
}): AiVideoEvaluationRecord {
  return {
    benchmarkId: params.benchmarkId,
    shotId: params.shotId,
    provider: params.provider,
    model: params.model,
    executionMode: params.executionMode,
    evaluatedAtIso: new Date().toISOString(),
    generationSuccess: false,
  };
}

export class AiVideoEvaluationInvalidError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Registro de evaluación de video-IA inválido: ${reasons.join("; ")}`);
    this.name = "AiVideoEvaluationInvalidError";
  }
}

/**
 * Verifica consistencia interna del registro — nunca decide SI algo fue
 * exitoso, solo que los campos no se contradigan entre sí. Lanza
 * AiVideoEvaluationInvalidError con TODAS las razones encontradas (no solo
 * la primera) si algo no cuadra.
 */
export function validateEvaluationRecord(record: AiVideoEvaluationRecord): void {
  const reasons: string[] = [];

  if (!record.generationSuccess && record.usableInFinalEdit) {
    reasons.push('usableInFinalEdit=true no es posible con generationSuccess=false (nada generado no puede ser "usable")');
  }
  if (!record.generationSuccess && (record.durationSeconds !== undefined || record.costUsd !== undefined)) {
    reasons.push("generationSuccess=false no debería traer durationSeconds/costUsd (no hay clip real que medir)");
  }
  if (record.executionMode === "real" && record.provider === "fixture") {
    reasons.push('executionMode="real" nunca puede venir del proveedor "fixture" — un resultado simulado nunca se presenta como real');
  }
  const scores: (SubjectiveScore | undefined)[] = [
    record.historicalPlausibility,
    record.promptAdherence,
    record.motionQuality,
    record.temporalConsistency,
    record.humanAnatomyQuality,
    record.physicalPlausibility,
    record.visualArtifacts,
    record.referenceConsistency,
  ];
  for (const score of scores) {
    if (score !== undefined && (score < 0 || score > 5 || !Number.isInteger(score))) {
      reasons.push(`puntuación subjetiva fuera de rango [0,5]: ${score}`);
    }
  }

  if (reasons.length > 0) throw new AiVideoEvaluationInvalidError(reasons);
}

/** Lista de criterios sin puntuar todavía para un shot — útil para saber qué falta llenar manualmente antes de considerar la evaluación completa. */
export function pendingEvaluationCriteria(record: AiVideoEvaluationRecord, requiredCriteria: BenchmarkEvaluationCriterion[]): BenchmarkEvaluationCriterion[] {
  return requiredCriteria.filter((c) => record[c as keyof AiVideoEvaluationRecord] === undefined);
}
