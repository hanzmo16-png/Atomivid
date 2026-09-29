/**
 * Experiment harness around PI V1.1 (PI itself is imported, never modified).
 * 1) Gate: PI cannot run unless the human baseline is sealed, intact and scored under the
 *    exact protocol that was hashed at seal time.
 * 2) Projection: PI receives ONLY the allowlisted input fields; human answers never reach it.
 * 3) Zero network: fetch throws for the whole shadow run; any call is counted and fails the test.
 */
import { parseShotContract, type ShotContract, type ShotContractInput } from "../production-intelligence/contract";
import { POLICY_V1_1 } from "../production-intelligence/policy";
import { PROFILES_V1_1 } from "../production-intelligence/profiles";
import { RATE_CARD_V1 } from "../production-intelligence/rate-card";
import { planMix, type MixInput, type MixPlan, type TimelineSlot } from "../production-intelligence/mix";
import { pinProject } from "../production-intelligence/pin";
import { ANSWER_FIELDS, INPUT_FIELDS, MOVING_SOURCES, type HumanShot } from "./schema";
import { sha256, verifySeal, type SealedBaseline } from "./seal";

export class ShadowGateError extends Error {}
export class ShadowLeakError extends Error {}
export class ShadowNetworkError extends Error {}

export type Protocol = { protocolVersion: string; subject: { policyVersion: string; profileVersion: string; contractVersion: string; rateCardVersion: string; memorySnapshotId: string; engineTreeSha256: string }; piRunParameters: { maxGeneratedDurationSeconds: number } } & Record<string, unknown>;

export const PI = { policy: POLICY_V1_1, profile: PROFILES_V1_1.LONGFORM_16X9, rateCard: RATE_CARD_V1, memorySnapshotId: "mem_empty", contractVersion: "shot-contract/1" } as const;

type ShotInput = Pick<HumanShot, (typeof INPUT_FIELDS)[number]>;

/** Structural projection: copies only allowlisted keys, so an answer field cannot pass by accident. */
export function projectInputs(shot: HumanShot): ShotInput {
  return Object.fromEntries(INPUT_FIELDS.map((k) => [k, shot[k]])) as ShotInput;
}

/** Shot input -> PI Shot Contract. Photos are stills (stockAvailable=false), never motion (Ocean NF1). */
export function toPiContract(s: ShotInput, maxGeneratedDuration: number): ShotContractInput {
  const riskFlags = [...(s.identityCritical ? ["identity_critical" as const] : []), ...(s.complexHands ? ["complex_hands" as const] : [])];
  const shotClass = s.multiHuman && s.shotClass !== "human_creature" ? "multi_human" : s.shotClass;
  return {
    shotId: s.shotId, shotClass, narrationIntent: s.narrationIntent, visualIntent: s.visualIntent, characters: s.characters,
    motionRequirement: s.motionRequirement, motionLeverage: s.motionLeverage, riskClass: s.riskClass, riskFlags,
    desiredDuration: s.duration, maxGeneratedDuration, qualityTier: s.qualityTier,
    existingApprovedAssetId: s.existingAsset && s.existingAssetApproved ? s.existingAsset : null,
    ...(s.existingAsset && s.existingAssetKind ? { existingAssetKind: s.existingAssetKind } : {}),
    stockAvailable: MOVING_SOURCES.includes(s.sourceType),
    continuityGroup: s.continuityGroup, previousState: s.previousState, nextState: s.nextState,
  };
}

export function buildShadowInput(sealed: SealedBaseline, protocol: Protocol, projectId: string, pinnedAt: string): MixInput {
  const shots = [...sealed.baseline.shots].sort((a, b) => a.timelineOrder - b.timelineOrder);
  const contracts: ShotContract[] = shots.map((s) => parseShotContract(toPiContract(projectInputs(s), protocol.piRunParameters.maxGeneratedDurationSeconds)));
  const timeline: TimelineSlot[] = shots.map((s) => ({ slotId: s.shotId, shotId: s.shotId, seconds: s.duration }));
  const pin = pinProject({ projectId, policyVersion: PI.policy.policyVersion, profileVersion: PI.profile.profileVersion, contractVersion: PI.contractVersion, rateCardVersion: PI.rateCard.rateCardVersion, memorySnapshotId: PI.memorySnapshotId }, pinnedAt);
  return { contracts, finishedSeconds: sealed.baseline.finishedSeconds, profile: PI.profile, policy: PI.policy, rateCard: PI.rateCard, pin, memorySnapshotId: PI.memorySnapshotId, projectBudgetUsd: sealed.baseline.productionBudgetUsd, timeline };
}

/** Fails if any human-answer key, or any human free-text answer, appears anywhere in the PI input. */
export function assertNoLeak(input: unknown, sealed: SealedBaseline): void {
  const keys = new Set<string>();
  const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(input);
  const leakedKeys = ANSWER_FIELDS.filter((k) => keys.has(k));
  if (leakedKeys.length) throw new ShadowLeakError(`human answer fields reached PI: ${leakedKeys.join(", ")}`);
  const text = JSON.stringify(input);
  for (const s of sealed.baseline.shots) for (const t of [s.humanReason, s.i2vPlan?.why].filter((x): x is string => !!x && x.length >= 12)) {
    if (text.includes(JSON.stringify(t).slice(1, -1))) throw new ShadowLeakError(`human answer text of ${s.shotId} reached PI`);
  }
}

export type ShadowResult = {
  baselineId: string; sealHash: string; protocolSha256: string; ranAt: string;
  versions: { policyVersion: string; profileVersion: string; contractVersion: string; rateCardVersion: string; memorySnapshotId: string };
  inputSha256: string; networkCalls: number; deterministic: boolean; plan: MixPlan; contracts: ShotContract[];
};

export function runShadowGated(o: { sealed: SealedBaseline | null | undefined; protocol: Protocol; ranAt: string; engineTreeSha256?: string; planner?: (i: MixInput) => MixPlan }): ShadowResult {
  const { sealed, protocol } = o;
  if (!sealed || sealed.HUMAN_BASELINE_SEALED !== true) throw new ShadowGateError("HUMAN_BASELINE_SEALED != true: PI V1.1 may not see the project");
  verifySeal(sealed);
  if (sha256(protocol) !== sealed.protocolSha256) throw new ShadowGateError("protocol changed after the seal (moving goalposts)");
  const sub = protocol.subject;
  const actual = { policyVersion: PI.policy.policyVersion, profileVersion: PI.profile.profileVersion, contractVersion: PI.contractVersion, rateCardVersion: PI.rateCard.rateCardVersion, memorySnapshotId: PI.memorySnapshotId };
  for (const [k, v] of Object.entries(actual)) if (sub[k as keyof typeof actual] !== v) throw new ShadowGateError(`pre-registered ${k}=${sub[k as keyof typeof actual]} but engine has ${v}`);
  if (o.engineTreeSha256 !== undefined && o.engineTreeSha256 !== sub.engineTreeSha256) throw new ShadowGateError(`engine tree ${o.engineTreeSha256} differs from the pre-registered ${sub.engineTreeSha256}`);

  const input = buildShadowInput(sealed, protocol, sealed.baseline.projectId, o.ranAt);
  assertNoLeak(input, sealed);
  const planner = o.planner ?? planMix;
  let networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { networkCalls++; throw new ShadowNetworkError("provider/network call forbidden during shadow"); }) as typeof fetch;
  let a: MixPlan, b: MixPlan;
  try {
    a = planner(input); b = planner(input);
  } catch (e) {
    if (networkCalls > 0) throw new ShadowNetworkError(`shadow attempted ${networkCalls} network call(s): ${(e as Error).message}`);
    throw e;
  } finally { globalThis.fetch = realFetch; }
  return { baselineId: sealed.baselineId, sealHash: sealed.sealHash, protocolSha256: sealed.protocolSha256, ranAt: o.ranAt, versions: actual, inputSha256: sha256(input), networkCalls, deterministic: JSON.stringify(a) === JSON.stringify(b), plan: a, contracts: input.contracts };
}
