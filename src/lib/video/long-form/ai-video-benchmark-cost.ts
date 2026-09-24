/**
 * Estimación de costo del Benchmark Suite de video-IA (P2A) — SEPARADO del
 * Cost Guard genérico de producción (ai-video-cost-guard.ts, que decide si
 * UN shot real de un documental puede generarse) y de video-cost-guard.ts
 * (hard stop ya gastado de VIDEO #001). Este módulo responde una pregunta
 * de PLANEACIÓN previa a cualquier generación real: "si generáramos estos 5
 * clips, ¿cuánto costaría en el peor caso, y cabe bajo el techo del
 * benchmark?" — nunca gasta, nunca hace red, solo calcula.
 *
 * Provider-agnóstico a propósito: recibe la tarifa USD/segundo como
 * parámetro (`BenchmarkCostModel`) en vez de importar nada de runway.ts —
 * el mismo cálculo debe poder repetirse para Luma/Veo/cualquier otro
 * proveedor sin tocar este archivo (ver P2A sección 3: "no casar Runway con
 * el pipeline").
 *
 * MAX_BENCHMARK_BUDGET_USD=$15 es un TECHO DE PLANEACIÓN, no una
 * autorización de gasto — withinCeiling=true aquí NUNCA implica permiso
 * para generar; la decisión de generar de verdad sigue pasando por
 * ai-video-cost-guard.ts (LONG_FORM_AI_VIDEO_ENABLED) y, en P2A, por una
 * autorización explícita nueva del usuario (ver informe final, sección L).
 */
import type { BenchmarkShotSpec } from "./ai-video-benchmark-manifest";

function numberEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Techo de PLANEACIÓN del benchmark completo — configurable, nunca una autorización de gasto por sí solo. */
export function getMaxBenchmarkBudgetUsd(): number {
  return numberEnv("MAX_BENCHMARK_BUDGET_USD", 15);
}

export type BenchmarkCostModel = {
  provider: string;
  model: string;
  costPerSecondUsd: number;
  /** true si `costPerSecondUsd` viene de documentación primaria verificada — false si es UNVERIFICADO (fuente secundaria o valor configurado por defecto). Nunca se omite: un costo estimado sin marcar su procedencia es tan peligroso como no tenerlo. */
  verifiedAgainstPrimaryDocs: boolean;
};

export type BenchmarkShotCostEstimate = {
  shotId: string;
  durationSec: number;
  costUsd: number;
};

export type BenchmarkCostEstimate = {
  benchmarkId: string;
  costModel: BenchmarkCostModel;
  perShot: BenchmarkShotCostEstimate[];
  clipCount: number;
  totalDurationSec: number;
  /** Costo de generar los `clipCount` clips UNA vez cada uno, sin ningún reintento. */
  totalCostUsd: number;
  /** Costo de UN solo reintento adicional, en el peor caso (el reintento cae sobre el clip más caro del lote). */
  oneRetryCostUsd: number;
  /** totalCostUsd + oneRetryCostUsd — peor caso permitido bajo la política de reintentos actual (máximo 1 reintento antes de fallback, ver ai-video-resolver.ts / retry policy documentada). */
  worstCaseCostUsd: number;
  ceilingUsd: number;
  withinCeiling: boolean;
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Costo estimado de UN clip bajo un `costModel` dado — pura, sin decidir elegibilidad ni presupuesto (eso ya lo hacen ai-video-eligibility.ts/ai-video-cost-guard.ts para producción real). */
export function estimateBenchmarkClipCost(shot: Pick<BenchmarkShotSpec, "shotId" | "durationSec">, costModel: BenchmarkCostModel): BenchmarkShotCostEstimate {
  return {
    shotId: shot.shotId,
    durationSec: shot.durationSec,
    costUsd: round4(shot.durationSec * costModel.costPerSecondUsd),
  };
}

/**
 * Estima el costo total del benchmark (5 shots u otro lote) bajo un
 * `costModel` — incluye el peor caso con UN reintento (política de
 * reintentos: intento 1 -> proveedor, intento 2 -> reintento permitido,
 * fallo -> fallback, ver informe P1) y compara contra
 * MAX_BENCHMARK_BUDGET_USD. Nunca gasta ni autoriza gasto.
 */
export function estimateBenchmarkSuiteCost(
  benchmarkId: string,
  shots: Pick<BenchmarkShotSpec, "shotId" | "durationSec">[],
  costModel: BenchmarkCostModel,
  ceilingUsd: number = getMaxBenchmarkBudgetUsd(),
): BenchmarkCostEstimate {
  const perShot = shots.map((s) => estimateBenchmarkClipCost(s, costModel));
  const totalDurationSec = round4(perShot.reduce((sum, s) => sum + s.durationSec, 0));
  const totalCostUsd = round4(perShot.reduce((sum, s) => sum + s.costUsd, 0));
  const oneRetryCostUsd = perShot.length > 0 ? Math.max(...perShot.map((s) => s.costUsd)) : 0;
  const worstCaseCostUsd = round4(totalCostUsd + oneRetryCostUsd);

  return {
    benchmarkId,
    costModel,
    perShot,
    clipCount: perShot.length,
    totalDurationSec,
    totalCostUsd,
    oneRetryCostUsd,
    worstCaseCostUsd,
    ceilingUsd,
    withinCeiling: worstCaseCostUsd <= ceilingUsd,
  };
}
