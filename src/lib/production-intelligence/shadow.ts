/**
 * Shadow Mode: a SHADOW policy receives the same inputs as the ACTIVE policy and
 * records what it would have decided. It has no provider port, no ledger and no
 * spend path by construction: it only calls the pure decide().
 */
import { decide, type DecideInput, type Decision } from "./decide";
import type { Policy } from "./policy";

export type ShadowComparison = {
  shotId: string;
  activeDecision: Decision;
  shadowDecision: Decision;
  estimatedDelta: { maxCostUsd: number; expectedCostUsd: number; generativeSeconds: number; methodChanged: boolean };
};

export class ShadowPolicyError extends Error {}

export function runShadow(input: DecideInput, shadow: Policy): ShadowComparison {
  if (shadow.status !== "SHADOW") throw new ShadowPolicyError(`Policy ${shadow.policyVersion} is ${shadow.status}, not SHADOW`);
  const activeDecision = decide(input);
  // The shadow decision is evaluated against its own version; the project pin still binds the active one.
  const shadowDecision = decide({ ...input, policy: shadow, pin: { ...input.pin, policyVersion: shadow.policyVersion } });
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    shotId: input.contract.shotId,
    activeDecision,
    shadowDecision,
    estimatedDelta: {
      maxCostUsd: r(shadowDecision.maxCostUsd - activeDecision.maxCostUsd),
      expectedCostUsd: r(shadowDecision.expectedCostUsd - activeDecision.expectedCostUsd),
      generativeSeconds: shadowDecision.generativeSeconds - activeDecision.generativeSeconds,
      methodChanged: shadowDecision.method !== activeDecision.method,
    },
  };
}
