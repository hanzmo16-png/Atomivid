export const PILOT_COST_STAGES = [
  "research",
  "script",
  "style",
  "voice",
  "images",
  "video",
  "music",
  "render",
] as const;

export type PilotCostStage = (typeof PILOT_COST_STAGES)[number];
export type PilotStageEstimate = {
  stage: PilotCostStage;
  /** Conservative ceiling for this stage, not historical or average spend. */
  ceilingUsd: number | null;
  /** Paid work from a failed attempt must be durable and reused before a pilot can be authorized. */
  retryPolicy: "reuse_paid_results" | "may_rebill";
  note?: string;
};

export type PilotBudgetEnvelope = {
  ready: boolean;
  blockers: string[];
  stageCeilings: Record<PilotCostStage, number | null>;
  subtotalUsd: number | null;
  contingencyPct: number;
  proposedAuthorizationCeilingUsd: number | null;
};

const centsUp = (value: number) => Math.ceil((value - Number.EPSILON) * 100) / 100;

/**
 * Builds an all-stage authorization proposal. It deliberately does not infer
 * missing provider prices and never treats historical spend as authorization.
 */
export function pilotBudgetEnvelope(
  stages: PilotStageEstimate[],
  contingencyPct = 20,
): PilotBudgetEnvelope {
  const blockers: string[] = [];
  const byStage = new Map<PilotCostStage, PilotStageEstimate>();
  for (const item of stages) {
    if (byStage.has(item.stage)) blockers.push(`duplicate_stage:${item.stage}`);
    else byStage.set(item.stage, item);
  }

  const stageCeilings = Object.fromEntries(
    PILOT_COST_STAGES.map((stage) => [stage, byStage.get(stage)?.ceilingUsd ?? null]),
  ) as Record<PilotCostStage, number | null>;

  if (!Number.isFinite(contingencyPct) || contingencyPct < 0 || contingencyPct > 100) {
    blockers.push("invalid_contingency");
  }
  for (const stage of PILOT_COST_STAGES) {
    const item = byStage.get(stage);
    if (!item) {
      blockers.push(`missing_stage:${stage}`);
      continue;
    }
    if (item.ceilingUsd === null || !Number.isFinite(item.ceilingUsd) || item.ceilingUsd < 0) {
      blockers.push(`unverified_cost:${stage}`);
    }
    if ((item.ceilingUsd ?? 0) > 0 && item.retryPolicy !== "reuse_paid_results") {
      blockers.push(`retry_may_rebill:${stage}`);
    }
  }

  const ready = blockers.length === 0;
  const subtotalUsd = ready
    ? centsUp(PILOT_COST_STAGES.reduce((sum, stage) => sum + (stageCeilings[stage] ?? 0), 0))
    : null;
  return {
    ready,
    blockers,
    stageCeilings,
    subtotalUsd,
    contingencyPct,
    proposedAuthorizationCeilingUsd:
      subtotalUsd === null ? null : centsUp(subtotalUsd * (1 + contingencyPct / 100)),
  };
}
