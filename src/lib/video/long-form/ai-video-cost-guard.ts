/**
 * Cost Guard centralizado del AI Video Pipeline de Long Form — SEPARADO
 * de video-cost-guard.ts (ese es el hard stop de UN video concreto,
 * VIDEO #001, en USD absolutos ya gastados) y de cost.ts (presupuesto
 * genérico de todo Long Form). Este módulo responde una pregunta previa y
 * más específica: "de lo que el eligibility engine recomienda tratar como
 * video IA, ¿cuánto es seguro conceder ANTES de generar nada?" — nunca
 * hace red, nunca gasta, solo decide.
 *
 * Toda la configuración vive AQUÍ (nunca dispersa en otros archivos) y es
 * seleccionable por preset (Economic/Balanced/Premium) sin reescribir el
 * pipeline — cada preset es solo un conjunto distinto de límites para las
 * MISMAS funciones de decisión de abajo.
 */
import { getFeatureFlags } from "../feature-flags";

export const AI_VIDEO_COST_PRESETS = ["economic", "balanced", "premium"] as const;
export type AiVideoCostPreset = (typeof AI_VIDEO_COST_PRESETS)[number];

export type AiVideoCostConfig = {
  preset: AiVideoCostPreset;
  /**
   * Techo de video-IA como % de la duración TOTAL del documental —
   * hipótesis de trabajo para Long Form: ≈10% en el preset "balanced".
   * NUNCA una regla rígida del sistema — configurable por preset y por
   * env var, y el cost guard igual respeta los topes absolutos de abajo
   * aunque el % todavía no se haya alcanzado.
   */
  budgetPercent: number;
  /** Tope absoluto de segundos de video-IA para todo el documental, independiente del %. */
  maxSeconds: number;
  /** Tope absoluto de clips de video-IA para todo el documental. */
  maxClips: number;
  /** Tope absoluto de USD en video-IA para todo el documental. */
  maxEstimatedCostUsd: number;
  /** Tarifa USD/segundo para un clip "ai_video" completo (texto/imagen→video). */
  aiVideoCostPerSecondUsd: number;
  /** Tarifa USD/segundo para "ai_image_motion" (imagen fija + tratamiento de cámara/motion, normalmente sin llamar a un VideoProvider real — Ken Burns avanzado u otro efecto de post, mucho más barato que un clip generado). */
  aiImageMotionCostPerSecondUsd: number;
};

const PRESET_DEFAULTS: Record<AiVideoCostPreset, Omit<AiVideoCostConfig, "preset">> = {
  economic: {
    budgetPercent: 4,
    maxSeconds: 20,
    maxClips: 2,
    maxEstimatedCostUsd: 1,
    aiVideoCostPerSecondUsd: 0.05,
    aiImageMotionCostPerSecondUsd: 0,
  },
  balanced: {
    budgetPercent: 10,
    maxSeconds: 60,
    maxClips: 6,
    maxEstimatedCostUsd: 3,
    aiVideoCostPerSecondUsd: 0.05,
    aiImageMotionCostPerSecondUsd: 0,
  },
  premium: {
    budgetPercent: 20,
    maxSeconds: 150,
    maxClips: 15,
    maxEstimatedCostUsd: 10,
    aiVideoCostPerSecondUsd: 0.08,
    aiImageMotionCostPerSecondUsd: 0,
  },
};

function numberEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolvePreset(preset?: AiVideoCostPreset): AiVideoCostPreset {
  if (preset) return preset;
  const flags = getFeatureFlags();
  const candidate = flags.longFormAiVideoCostPreset as AiVideoCostPreset;
  return (AI_VIDEO_COST_PRESETS as readonly string[]).includes(candidate) ? candidate : "balanced";
}

/**
 * Config efectiva: parte de los defaults del preset y los deja
 * sobreescribir individualmente por env var (nunca al revés) — así un
 * despliegue puede quedarse en "balanced" pero ajustar un solo número sin
 * tener que definir los demás.
 */
export function getAiVideoCostConfig(preset?: AiVideoCostPreset): AiVideoCostConfig {
  const resolved = resolvePreset(preset);
  const defaults = PRESET_DEFAULTS[resolved];
  return {
    preset: resolved,
    budgetPercent: numberEnv("AI_VIDEO_BUDGET_PERCENT", defaults.budgetPercent),
    maxSeconds: numberEnv("MAX_AI_VIDEO_SECONDS", defaults.maxSeconds),
    maxClips: numberEnv("MAX_AI_VIDEO_CLIPS", defaults.maxClips),
    maxEstimatedCostUsd: numberEnv("MAX_ESTIMATED_VIDEO_COST_USD", defaults.maxEstimatedCostUsd),
    aiVideoCostPerSecondUsd: numberEnv("AI_VIDEO_COST_PER_SECOND_USD", defaults.aiVideoCostPerSecondUsd),
    aiImageMotionCostPerSecondUsd: numberEnv("AI_IMAGE_MOTION_COST_PER_SECOND_USD", defaults.aiImageMotionCostPerSecondUsd),
  };
}

export type AiVideoLedgerState = {
  usedSeconds: number;
  usedClips: number;
  spentUsd: number;
};

export function emptyAiVideoLedgerState(): AiVideoLedgerState {
  return { usedSeconds: 0, usedClips: 0, spentUsd: 0 };
}

export type AiVideoBudgetDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * ¿Cabe UN clip candidato (duración + costo estimado) dentro de TODOS los
 * límites configurados, dado lo ya concedido (`ledger`) y la duración
 * TOTAL del documental (para el % del budget)? Verifica los cuatro topes
 * de forma independiente — cualquiera que falle basta para rechazar.
 * Pura: nunca toca red ni modifica `ledger` (el llamador decide cuándo
 * "confirmar" un gasto, igual que video-cost-guard.ts/recordSpend).
 */
export function assertAiVideoBudget(
  ledger: AiVideoLedgerState,
  candidateSeconds: number,
  candidateCostUsd: number,
  totalDocumentaryDurationSec: number,
  config: AiVideoCostConfig,
): AiVideoBudgetDecision {
  const flags = getFeatureFlags();
  if (!flags.longFormAiVideoEnabled) {
    return { allowed: false, reason: "LONG_FORM_AI_VIDEO_ENABLED=false — el AI Video Pipeline está apagado globalmente" };
  }

  const wouldUseSeconds = ledger.usedSeconds + candidateSeconds;
  const wouldUseClips = ledger.usedClips + 1;
  const wouldSpendUsd = ledger.spentUsd + candidateCostUsd;

  if (totalDocumentaryDurationSec > 0) {
    const percentUsed = (wouldUseSeconds / totalDocumentaryDurationSec) * 100;
    if (percentUsed > config.budgetPercent) {
      return {
        allowed: false,
        reason: `excedería AI_VIDEO_BUDGET_PERCENT (${config.budgetPercent}%): ${wouldUseSeconds.toFixed(1)}s de ${totalDocumentaryDurationSec.toFixed(1)}s totales = ${percentUsed.toFixed(1)}%`,
      };
    }
  }
  if (wouldUseSeconds > config.maxSeconds) {
    return {
      allowed: false,
      reason: `excedería MAX_AI_VIDEO_SECONDS (${config.maxSeconds}s): ${wouldUseSeconds.toFixed(1)}s`,
    };
  }
  if (wouldUseClips > config.maxClips) {
    return {
      allowed: false,
      reason: `excedería MAX_AI_VIDEO_CLIPS (${config.maxClips}): ${wouldUseClips} clips`,
    };
  }
  if (wouldSpendUsd > config.maxEstimatedCostUsd) {
    return {
      allowed: false,
      reason: `excedería MAX_ESTIMATED_VIDEO_COST_USD ($${config.maxEstimatedCostUsd}): $${wouldSpendUsd.toFixed(4)}`,
    };
  }
  return { allowed: true };
}

/** Anota un gasto YA CONFIRMADO — pura, no toca disco/red (mismo criterio que video-cost-guard.ts: el llamador decide cuándo persistirlo). */
export function recordAiVideoSpend(ledger: AiVideoLedgerState, seconds: number, costUsd: number): AiVideoLedgerState {
  return {
    usedSeconds: ledger.usedSeconds + seconds,
    usedClips: ledger.usedClips + 1,
    spentUsd: ledger.spentUsd + costUsd,
  };
}
