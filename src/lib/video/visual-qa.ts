/**
 * Evaluador de calidad visual PRE-render (VisualQualityEvaluator). Solo
 * implementa lo que se puede verificar de forma determinista SIN un
 * modelo multimodal real configurado (ninguno lo está hoy en este
 * proyecto): dimensiones, tamaño de archivo, tipo MIME esperado,
 * proximidad de aspecto. Los chequeos que SÍ requieren visión real
 * (correspondencia semántica, marcas de agua, texto extraño, riesgo de
 * mala interpretación) quedan como `evaluated: false` explícito — nunca
 * se inventa un puntaje falso para esos campos (ver VISUAL_QA_ENABLED en
 * feature-flags.ts: apagado por defecto porque hoy solo cubre chequeos
 * mecánicos, no evaluación semántica real).
 */
import type { GenerativeAsset } from "@/lib/providers/types";
import type { FallbackStep, StoryboardScene } from "./storyboard/types";

export type QaCheckResult = {
  passed: boolean;
  /** false = no se pudo evaluar de forma determinista (requiere modelo multimodal real). */
  evaluated: boolean;
  reason: string;
};

export type VisualQaReport = {
  technicalQuality: QaCheckResult;
  aspectRatioSafety: QaCheckResult;
  semanticMatch: QaCheckResult;
  watermarkFree: QaCheckResult;
  misinterpretationRisk: QaCheckResult;
  /** true solo si TODOS los chequeos evaluables (evaluated=true) pasaron — los no evaluables no cuentan como fallo. */
  passed: boolean;
  mode: "deterministic" | "simulated";
};

const MIN_WIDTH = 720;
const MIN_HEIGHT = 1280;

function checkTechnicalQuality(asset: GenerativeAsset): QaCheckResult {
  if (asset.buffer.byteLength === 0) {
    return { passed: false, evaluated: true, reason: "archivo con tamaño 0 bytes" };
  }
  if (asset.width && asset.width < MIN_WIDTH) {
    return { passed: false, evaluated: true, reason: `ancho ${asset.width}px por debajo del mínimo ${MIN_WIDTH}px` };
  }
  if (asset.height && asset.height < MIN_HEIGHT) {
    return { passed: false, evaluated: true, reason: `alto ${asset.height}px por debajo del mínimo ${MIN_HEIGHT}px` };
  }
  return { passed: true, evaluated: true, reason: "tamaño de archivo y dimensiones dentro de lo esperado" };
}

function checkAspectRatioSafety(asset: GenerativeAsset): QaCheckResult {
  if (!asset.width || !asset.height) {
    return { passed: true, evaluated: false, reason: "el proveedor no informó dimensiones" };
  }
  const ratio = asset.width / asset.height;
  const target9x16 = 9 / 16;
  const withinTolerance = Math.abs(ratio - target9x16) < 0.35; // tolerante: se recorta en Remotion, no necesita ser exacto.
  return {
    passed: withinTolerance,
    evaluated: true,
    reason: withinTolerance
      ? "relación de aspecto compatible con recorte seguro a 9:16"
      : `relación de aspecto ${ratio.toFixed(2)} demasiado alejada de 9:16 para un recorte seguro`,
  };
}

/** Correspondencia semántica, marcas de agua y riesgo de mala interpretación requieren visión real — nunca se simulan como "pasado". */
function notEvaluable(reason: string): QaCheckResult {
  return { passed: true, evaluated: false, reason };
}

export function evaluateVisualQuality(asset: GenerativeAsset, scene: StoryboardScene): VisualQaReport {
  const technicalQuality = checkTechnicalQuality(asset);
  const aspectRatioSafety = checkAspectRatioSafety(asset);
  const semanticMatch = notEvaluable(
    `requiere modelo multimodal (no configurado) para comparar contra: "${scene.visibleAction}"`,
  );
  const watermarkFree = notEvaluable("requiere modelo multimodal (no configurado) para detectar marcas de agua/texto");
  const misinterpretationRisk = notEvaluable(
    "requiere modelo multimodal (no configurado) para evaluar riesgo de interpretación errónea",
  );

  const evaluableChecks = [technicalQuality, aspectRatioSafety, semanticMatch, watermarkFree, misinterpretationRisk].filter(
    (c) => c.evaluated,
  );

  return {
    technicalQuality,
    aspectRatioSafety,
    semanticMatch,
    watermarkFree,
    misinterpretationRisk,
    passed: evaluableChecks.every((c) => c.passed),
    mode: "deterministic",
  };
}

/** Modo simulación explícito para pruebas/dry-run — nunca se usa como si fuera una evaluación real. */
export function simulateVisualQuality(): VisualQaReport {
  const simulated: QaCheckResult = { passed: true, evaluated: false, reason: "modo simulación — sin evaluación real" };
  return {
    technicalQuality: simulated,
    aspectRatioSafety: simulated,
    semanticMatch: simulated,
    watermarkFree: simulated,
    misinterpretationRisk: simulated,
    passed: true,
    mode: "simulated",
  };
}

/**
 * Da el siguiente paso de fallback a intentar, respetando el orden
 * declarado en el storyboard y el número de pasos ya intentados — nunca
 * devuelve un paso repetido ni permite más pasos que los declarados
 * (evita reintentos infinitos por construcción).
 */
export function nextFallbackStep(scene: StoryboardScene, stepsAlreadyTried: number): FallbackStep | null {
  if (stepsAlreadyTried >= scene.fallbackStrategy.length) return null;
  return scene.fallbackStrategy[stepsAlreadyTried];
}
