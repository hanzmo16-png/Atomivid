/**
 * Gate explícito de ejecución del benchmark REAL de video-IA (P2A.5
 * sección 12) — reutilizable por cualquier futuro script/ruta de P2B, no
 * llamado todavía por ningún camino en vivo (P2A.5 nunca ejecuta). Cinco
 * condiciones INDEPENDIENTES deben ser todas verdaderas; basta con que
 * falte UNA (p. ej. solo configurar una API key) para que se bloquee.
 * Pura — nunca hace red, nunca decide "generar", solo si sería PERMITIDO.
 */
import type { ReferenceImageStatus } from "./ai-video-benchmark-v2-active";

export type BenchmarkExecutionGateParams = {
  /** Debe ser exactamente "approved" — "not_generated"/"pending_review" bloquean, sin excepción. */
  referenceImageStatus: ReferenceImageStatus;
  /** Feature flag global (getFeatureFlags().longFormAiVideoEnabled) — inyectado, nunca leído directamente aquí, para mantener esta función pura y testeable. */
  longFormAiVideoEnabled: boolean;
  /** true SOLO si el llamador pidió explícitamente ejecutar el benchmark real (nunca por defecto) — evita que configurar una API key por sí sola dispare una generación. */
  explicitBenchmarkExecutionMode: boolean;
  /** Resultado YA calculado del Cost Guard (ai-video-cost-guard.ts/ai-video-benchmark-cost.ts) — este gate no repite esa lógica, solo exige que ya haya dado permiso. */
  costGuardAllowed: boolean;
  /** videoProvider.isAvailable() del proveedor real elegido. */
  providerConfigured: boolean;
};

export type BenchmarkExecutionGateDecision = { allowed: true } | { allowed: false; reasons: string[] };

/** Evalúa las 5 condiciones — nunca lanza, devuelve TODAS las razones de bloqueo encontradas (no solo la primera). */
export function evaluateBenchmarkExecutionGate(params: BenchmarkExecutionGateParams): BenchmarkExecutionGateDecision {
  const reasons: string[] = [];
  if (params.referenceImageStatus !== "approved") {
    reasons.push(`referenceImageStatus="${params.referenceImageStatus}" (se requiere "approved") — nunca se genera sin una imagen de referencia aprobada por un humano`);
  }
  if (!params.longFormAiVideoEnabled) {
    reasons.push("LONG_FORM_AI_VIDEO_ENABLED=false");
  }
  if (!params.explicitBenchmarkExecutionMode) {
    reasons.push("explicitBenchmarkExecutionMode=false — configurar una API key por sí sola nunca dispara una generación");
  }
  if (!params.costGuardAllowed) {
    reasons.push("el Cost Guard no lo permite");
  }
  if (!params.providerConfigured) {
    reasons.push("el proveedor de video real no está configurado (isAvailable()=false)");
  }
  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons };
}

export class BenchmarkExecutionNotAllowedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Ejecución del benchmark real de video-IA bloqueada: ${reasons.join("; ")}`);
    this.name = "BenchmarkExecutionNotAllowedError";
  }
}

/** Lanza BenchmarkExecutionNotAllowedError si alguna condición falla — para uso directo de un futuro script de P2B antes de llamar a un VideoProvider real. */
export function assertBenchmarkExecutionAllowed(params: BenchmarkExecutionGateParams): void {
  const decision = evaluateBenchmarkExecutionGate(params);
  if (!decision.allowed) throw new BenchmarkExecutionNotAllowedError(decision.reasons);
}
