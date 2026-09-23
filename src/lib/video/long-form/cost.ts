import type { LongFormCostEstimate, NarrativeBeat } from "./types";

export type LongFormBudget = {
  maxTotalUsd: number;
  maxLlmUsd: number;
  maxTtsUsd: number;
  maxImageUsd: number;
};

export const DEFAULT_LONG_FORM_BUDGET: LongFormBudget = {
  maxTotalUsd: 12,
  maxLlmUsd: 3,
  maxTtsUsd: 6,
  maxImageUsd: 2,
};

function envNumber(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getLongFormBudget(
  env: Record<string, string | undefined> = process.env,
): LongFormBudget {
  return {
    maxTotalUsd: envNumber("LONG_FORM_MAX_TOTAL_USD", DEFAULT_LONG_FORM_BUDGET.maxTotalUsd, env),
    maxLlmUsd: envNumber("LONG_FORM_MAX_LLM_USD", DEFAULT_LONG_FORM_BUDGET.maxLlmUsd, env),
    maxTtsUsd: envNumber("LONG_FORM_MAX_TTS_USD", DEFAULT_LONG_FORM_BUDGET.maxTtsUsd, env),
    maxImageUsd: envNumber("LONG_FORM_MAX_IMAGE_USD", DEFAULT_LONG_FORM_BUDGET.maxImageUsd, env),
  };
}

/** Image dollars follow generated shots, not one still per beat. */
export function estimateLongFormCost(input: {
  durationSec: number;
  beats: NarrativeBeat[];
  llmUsd?: number;
  ttsUsdPer1kChars?: number;
  imageUsdEach?: number;
}): LongFormCostEstimate {
  const narration = input.beats.map((b) => b.narration).join(" ");
  const chars = narration.length;
  const shots = input.beats.flatMap((b) => b.shots);
  const ttsRate = input.ttsUsdPer1kChars ?? 0.3;
  const imageEach = input.imageUsdEach ?? 0.04;
  const generatedStills = shots.filter(
    (s) => s.type === "generated_placeholder" || s.source === "generated",
  ).length;
  const llmUsd = input.llmUsd ?? 0.4;
  const ttsUsd = (chars / 1000) * ttsRate;
  const imageUsd = generatedStills * imageEach;
  const visualUsd = imageUsd;
  const totalUsd = llmUsd + ttsUsd + visualUsd;
  const minutes = Math.max(input.durationSec / 60, 0.01);
  return {
    durationSec: input.durationSec,
    sceneCount: input.beats.length,
    assetCount: shots.length,
    llmUsd: round4(llmUsd),
    ttsUsd: round4(ttsUsd),
    imageUsd: round4(imageUsd),
    visualUsd: round4(visualUsd),
    totalUsd: round4(totalUsd),
    usdPerMinute: round4(totalUsd / minutes),
  };
}

export function assertWithinBudget(
  estimate: LongFormCostEstimate,
  budget = getLongFormBudget(),
): void {
  if (estimate.llmUsd > budget.maxLlmUsd) {
    throw new Error(`LLM budget exceeded: ${estimate.llmUsd} > ${budget.maxLlmUsd}`);
  }
  if (estimate.ttsUsd > budget.maxTtsUsd) {
    throw new Error(`TTS budget exceeded: ${estimate.ttsUsd} > ${budget.maxTtsUsd}`);
  }
  if (estimate.imageUsd > budget.maxImageUsd) {
    throw new Error(`Image budget exceeded: ${estimate.imageUsd} > ${budget.maxImageUsd}`);
  }
  if (estimate.totalUsd > budget.maxTotalUsd) {
    throw new Error(`Total budget exceeded: ${estimate.totalUsd} > ${budget.maxTotalUsd}`);
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
