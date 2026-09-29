/**
 * Production Policy Engine: ONE place for production constraints. It composes what already
 * exists (PI policy/profile for ladder rules and generative budget, the provider registry
 * for accounts) and adds the constraints that were scattered across scripts: provider
 * eligibility per asset type, aspect/resolution, spending ceilings, retry/fallback,
 * provenance and content rules, concurrency. Pure data + pure checks.
 */
import { POLICY_V1_1, type Policy } from "../production-intelligence/policy";
import { PROFILES_V1_1, type ProductionProfile } from "../production-intelligence/profiles";
import { PROVIDER_ACCOUNTS } from "../production-intelligence/capacity/accounts";
import { hasFlag } from "../production-intelligence/contract";
import type { ProductionShotRecord } from "./shot-record";

export type ProductionPolicy = {
  policyId: string;
  piPolicy: Policy;
  profile: ProductionProfile;
  aspect: "16:9" | "9:16";
  resolution: { width: number; height: number; fps: number };
  /** Providers allowed per asset type (first = preferred). */
  providerEligibility: Record<ProductionShotRecord["assetType"], readonly ProductionShotRecord["sourceProvider"][]>;
  budget: { projectCeilingUsd: number; perProviderCeilingUsd: Record<string, number>; perShotCeilingUsd: number };
  premiumVideo: { heroClipsMax: number; economyClipsMax: number };
  retries: { motionAttemptsMax: number; stillAttemptsMax: number; infrastructureRetriesMax: number };
  fallback: { onMotionFailure: "STILL_MOTION_FALLBACK"; onStillFailure: "STOCK_FALLBACK" | "TEXT_CARD_FALLBACK"; onRepeatedFailure: "HUMAN_REVIEW" };
  provenance: { aiRecreationMustBeLabelled: true; forbidRealDocumentedForAi: true };
  content: { forbiddenElementsGlobal: readonly string[]; identityCriticalNeedsReference: boolean };
  concurrency: Record<string, { maxConcurrent: number; maxPerDay: number | null }>;
};

const acct = (p: "runway" | "openai" | "elevenlabs") => PROVIDER_ACCOUNTS.find((a) => a.provider === p)!;

export const PRODUCTION_POLICY_V1: ProductionPolicy = {
  policyId: "production-policy/1",
  piPolicy: POLICY_V1_1,
  profile: PROFILES_V1_1.LONGFORM_16X9,
  aspect: "16:9",
  resolution: { width: 1920, height: 1080, fps: 30 },
  providerEligibility: {
    stock_video: ["pexels"], stock_image: ["pexels"], generated_placeholder: ["openai"], text: ["internal"], diagram: ["internal"], map: ["internal"],
    ken_burns_image: ["openai", "pexels", "existing"], ai_video: ["runway", "veo"],
  },
  budget: { projectCeilingUsd: 40, perProviderCeilingUsd: { openai: 20, runway: 20, elevenlabs: 10, pexels: 0, internal: 0, existing: 0, manual: 0, veo: 0 }, perShotCeilingUsd: 2 },
  premiumVideo: { heroClipsMax: PROFILES_V1_1.LONGFORM_16X9.heroQuota, economyClipsMax: 24 },
  retries: { motionAttemptsMax: PROFILES_V1_1.LONGFORM_16X9.maxMotionAttempts, stillAttemptsMax: PROFILES_V1_1.LONGFORM_16X9.maxStillAttempts, infrastructureRetriesMax: POLICY_V1_1.params.maxInfrastructureRetries },
  fallback: { onMotionFailure: "STILL_MOTION_FALLBACK", onStillFailure: "STOCK_FALLBACK", onRepeatedFailure: "HUMAN_REVIEW" },
  provenance: { aiRecreationMustBeLabelled: true, forbidRealDocumentedForAi: true },
  content: { forbiddenElementsGlobal: ["modern text overlays inside generated images", "readable invented inscriptions", "watermarks"], identityCriticalNeedsReference: true },
  // Runway dev tier 1 as recorded in the provider registry; others unknown -> conservative 1.
  concurrency: { runway: { maxConcurrent: 1, maxPerDay: 50 }, openai: { maxConcurrent: 2, maxPerDay: null }, elevenlabs: { maxConcurrent: 1, maxPerDay: null }, pexels: { maxConcurrent: 2, maxPerDay: null } },
};

export type PolicyViolation = { rule: string; shotId: string | null; message: string };

/** Static checks of one shot record against the policy (no engine call, no spend). */
export function checkShotPolicy(r: ProductionShotRecord, p: ProductionPolicy): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  const id = r.contract.shotId;
  const eligible = p.providerEligibility[r.assetType];
  if (!eligible.includes(r.sourceProvider)) v.push({ rule: "P_PROVIDER_ELIGIBILITY", shotId: id, message: `${r.sourceProvider} is not eligible for ${r.assetType} (allowed: ${eligible.join(", ")})` });
  if (r.reservedCostUsd > p.budget.perShotCeilingUsd) v.push({ rule: "P_SHOT_CEILING", shotId: id, message: `reserved USD ${r.reservedCostUsd} exceeds the per-shot ceiling USD ${p.budget.perShotCeilingUsd}` });
  if (r.retryCount > p.retries.motionAttemptsMax + p.retries.stillAttemptsMax + p.retries.infrastructureRetriesMax) v.push({ rule: "P_RETRY_LIMIT", shotId: id, message: `retryCount ${r.retryCount} beyond every authorized retry` });
  if (p.provenance.aiRecreationMustBeLabelled && (r.assetType === "ai_video" || r.sourceProvider === "openai") && r.historicalClassification === null) v.push({ rule: "P_PROVENANCE_LABEL", shotId: id, message: "AI-generated visuals need a historicalClassification (reconstruction / speculative_reconstruction)" });
  if (p.provenance.forbidRealDocumentedForAi && r.provenance?.kind === "ai_recreation" && r.historicalClassification === "real_documented") v.push({ rule: "P_PROVENANCE_REAL", shotId: id, message: "AI recreation labelled as real_documented" });
  if (p.content.identityCriticalNeedsReference && hasFlag(r.contract, "identity_critical") && !r.characterReferences.some((c) => c.referenceAssetId)) v.push({ rule: "P_IDENTITY_REFERENCE", shotId: id, message: "identity-critical shot without a character reference asset" });
  for (const fe of p.content.forbiddenElementsGlobal) if (!r.contract.forbiddenElements.includes(fe) && (r.sourceProvider === "openai" || r.assetType === "ai_video")) v.push({ rule: "P_FORBIDDEN_ELEMENTS", shotId: id, message: `generated shot must forbid "${fe}"` });
  return v;
}

/** Project-level checks: premium allocation, project and provider ceilings. */
export function checkProjectPolicy(records: ProductionShotRecord[], p: ProductionPolicy): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  const hero = records.filter((r) => r.plannedMethod === "I2V_HERO").length;
  const economy = records.filter((r) => r.plannedMethod === "I2V_ECONOMY").length;
  if (hero > p.premiumVideo.heroClipsMax) v.push({ rule: "P_HERO_QUOTA", shotId: null, message: `${hero} hero clips > ${p.premiumVideo.heroClipsMax}` });
  if (economy > p.premiumVideo.economyClipsMax) v.push({ rule: "P_ECONOMY_QUOTA", shotId: null, message: `${economy} economy clips > ${p.premiumVideo.economyClipsMax}` });
  const reserved = records.reduce((t, r) => t + r.reservedCostUsd, 0);
  if (reserved > p.budget.projectCeilingUsd) v.push({ rule: "P_PROJECT_CEILING", shotId: null, message: `reserved USD ${reserved.toFixed(2)} > project ceiling USD ${p.budget.projectCeilingUsd}` });
  const byProvider = new Map<string, number>();
  for (const r of records) byProvider.set(r.sourceProvider, (byProvider.get(r.sourceProvider) ?? 0) + r.reservedCostUsd);
  for (const [prov, usd] of byProvider) { const cap = p.budget.perProviderCeilingUsd[prov]; if (cap !== undefined && usd > cap) v.push({ rule: "P_PROVIDER_CEILING", shotId: null, message: `${prov}: reserved USD ${usd.toFixed(2)} > ceiling USD ${cap}` }); }
  for (const r of records) v.push(...checkShotPolicy(r, p));
  return v;
}

export function providerAccountFor(provider: string) {
  return provider === "runway" || provider === "openai" || provider === "elevenlabs" ? acct(provider) : null;
}
