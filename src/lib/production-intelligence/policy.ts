/**
 * Policy versions and their explicit lifecycle. Telemetry and memory never
 * write here; only an explicit, global promotion changes which policy is ACTIVE.
 */
export type PolicyStatus = "CANDIDATE" | "SHADOW" | "ACTIVE" | "RETIRED";

export type PolicyParams = {
  /** R02: human_creature shots animate only when motion leverage is HIGH. */
  humanCreatureNeedsHighLeverage: boolean;
  /** R04: identity-critical humans with LOW leverage stay still-motion. */
  identityCriticalLowLeverageStill: boolean;
  /** R05/R06: elevated-risk shots use economy video only when motion is essential (HIGH). */
  elevatedRiskNeedsHighLeverage: boolean;
  /** R07/R08: after a semantic failure, a HIGH-leverage shot may try ONE materially simpler variant. */
  allowSimplifiedRetryAfterSemanticFailure: boolean;
  /** R09: infrastructure retries (same idempotency key) after transport failures. */
  maxInfrastructureRetries: number;
  /** Mix: minimum leverage eligible for an upgrade. */
  minUpgradeLeverage: "MEDIUM" | "HIGH";
  // ---- V1.1 (absent in V1 => V1 behavior) ----
  /** R12: existing + approved + usable assets are reused and never repurchased automatically. */
  reuseApprovedAssets?: boolean;
  /** Budget is a ceiling: a generative upgrade needs an explicit, valid upgradeReason. */
  requireUpgradeReason?: boolean;
  /** Anti-slideshow: break over-long runs of flat stills, non-generative motion first. */
  timelineRhythm?: boolean;
};

export type Policy = { policyVersion: string; status: PolicyStatus; params: PolicyParams; notes: string };

export const POLICY_V1: Policy = {
  policyVersion: "policy/1.0.0",
  status: "ACTIVE",
  notes: "Deterministic V1 derived from general DULCE learnings; no learned components.",
  params: {
    humanCreatureNeedsHighLeverage: true,
    identityCriticalLowLeverageStill: true,
    elevatedRiskNeedsHighLeverage: true,
    allowSimplifiedRetryAfterSemanticFailure: true,
    maxInfrastructureRetries: 1,
    minUpgradeLeverage: "MEDIUM",
  },
};

/** V1.1 CANDIDATE: V1 plus exactly three evidence-driven changes (reuse, budget ceiling, timeline rhythm). */
export const POLICY_V1_1: Policy = {
  policyVersion: "policy/1.1.0-candidate",
  status: "CANDIDATE",
  notes: "Candidate after the V1 exam FAIL: R12 reuse, budget as ceiling with explicit upgradeReason, deterministic anti-slideshow. R04 unchanged (OPEN_QUESTION_IDENTITY_POLICY).",
  params: { ...POLICY_V1.params, reuseApprovedAssets: true, requireUpgradeReason: true, timelineRhythm: true },
};

const LEGAL: Record<PolicyStatus, PolicyStatus[]> = {
  CANDIDATE: ["SHADOW", "RETIRED"],
  SHADOW: ["ACTIVE", "RETIRED", "CANDIDATE"],
  ACTIVE: ["RETIRED"],
  RETIRED: [],
};

export class PolicyRegistryError extends Error {}

export type PolicyRegistry = { policies: Policy[]; history: { policyVersion: string; from: PolicyStatus; to: PolicyStatus; by: string; at: string; reason: string }[] };

/**
 * Explicit promotion. Only a global operator may change the registry; a project
 * or tenant context is rejected (a single project can never alter global policy).
 * Promoting to ACTIVE retires the previously ACTIVE policy.
 */
export function promotePolicy(
  reg: PolicyRegistry,
  policyVersion: string,
  to: PolicyStatus,
  actor: { scope: "global-operator" | "project" | "tenant"; id: string },
  reason: string,
  at: string,
): PolicyRegistry {
  if (actor.scope !== "global-operator") throw new PolicyRegistryError(`Scope ${actor.scope} cannot change global policy`);
  if (!reason.trim()) throw new PolicyRegistryError("Promotion requires a written reason");
  const p = reg.policies.find((x) => x.policyVersion === policyVersion);
  if (!p) throw new PolicyRegistryError("Unknown policy " + policyVersion);
  if (!LEGAL[p.status].includes(to)) throw new PolicyRegistryError(`Illegal policy transition ${p.status} -> ${to}`);
  const history = [...reg.history, { policyVersion, from: p.status, to, by: actor.id, at, reason }];
  const policies = reg.policies.map((x) => {
    if (x.policyVersion === policyVersion) return { ...x, status: to };
    if (to === "ACTIVE" && x.status === "ACTIVE") {
      history.push({ policyVersion: x.policyVersion, from: "ACTIVE", to: "RETIRED", by: actor.id, at, reason: `superseded by ${policyVersion}` });
      return { ...x, status: "RETIRED" as const };
    }
    return x;
  });
  return { policies, history };
}

export function activePolicy(reg: PolicyRegistry): Policy {
  const a = reg.policies.filter((p) => p.status === "ACTIVE");
  if (a.length !== 1) throw new PolicyRegistryError(`Expected exactly one ACTIVE policy, found ${a.length}`);
  return a[0];
}
