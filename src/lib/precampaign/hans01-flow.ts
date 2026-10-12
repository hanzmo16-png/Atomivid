/**
 * hans-01 precampaign media flow, provider-agnostic so it can be proven with synthetic stores (Codex correction
 * chatgpt-22). Order is fixed and each step is a precondition of the next:
 *   1. delivery preflight (route explicitly approved AND reachable) — before ANY paid call;
 *   2. plan check: cumulative project exposure + voice bound + avatar allowance ≤ cap;
 *   3. voice (budget-admitted, ledger-guarded);
 *   4. cut the avatar lines from that same audio; plan re-checked with the real durations;
 *   5. each avatar clip budget-admitted on the CURRENT cumulative exposure, then ledger-guarded; an
 *      attributed cost above its reservation stops the run before the next clip;
 *   6. delivery.
 * A stored result is reused by the gate at zero new cost; the cumulative total is never reset.
 */
import { guardPaidCall, paidCallKey, type LedgerStore, type PaidCallHooks, type PaidCallSpec } from "@/lib/paid-calls/gate";
import { admitPaidCall, ceilCents, projectExposure, ProjectBudgetExceededError, ProjectUncertainStateError, type ProjectBudgetStore } from "@/lib/paid-calls/project-budget";

const EPS = 1e-9;
const cents = (usd: number) => Math.round(usd * 100) / 100;

export class SpendAboveReservationError extends Error {
  constructor(readonly step: string, readonly reservedUsd: number, readonly attributedUsd: number) {
    super(`spend_above_reservation:${step}: attributed ${attributedUsd} > reserved ${reservedUsd}`);
    this.name = "SpendAboveReservationError";
  }
}

export type ClipKey = "apertura" | "cierre";
export type PaidStep<T> = { spec: PaidCallSpec; hooks: PaidCallHooks<T> };
export type StepOutcome<T> = { result: T; reused: boolean; reservedUsd: number; attributedUsd: number; observedAccountDeltaUsd: number | null };

export type Hans01Deps<V, A extends { seconds: number }, C, D> = {
  projectId: string;
  capUsd: number;
  ledger: LedgerStore;
  budget: ProjectBudgetStore;
  /** Throws unless the delivery route is explicitly approved and reachable right now. */
  deliveryPreflight(): Promise<void>;
  voice: PaidStep<V>;
  /** Conservative USD per second of avatar video. */
  avatarUsdPerSecond: number;
  /** Allowance for both clips before the real durations are known (seconds). */
  avatarAllowanceSeconds: number;
  cut(voice: V): Promise<Record<ClipKey, A>>;
  clip(k: ClipKey, audio: A): PaidStep<C>;
  /** Optional account balance (USD). Its delta is an observation of the account, not an exact attribution. */
  observeAccountUsd?(): Promise<number>;
  deliver(out: { voice: V; audio: Record<ClipKey, A>; clips: Record<ClipKey, C> }): Promise<D>;
};

async function paidStep<T>(d: Pick<Hans01Deps<unknown, { seconds: number }, unknown, unknown>, "ledger" | "budget" | "capUsd" | "observeAccountUsd">, name: string, step: PaidStep<T>): Promise<StepOutcome<T>> {
  const spec = { ...step.spec, reservedUsd: ceilCents(step.spec.reservedUsd) };
  const forKey = paidCallKey(spec, 0);
  const admission = await admitPaidCall(d.budget, { projectId: spec.projectId, forKey, usd: spec.reservedUsd, capUsd: d.capUsd });
  const before = d.observeAccountUsd ? await d.observeAccountUsd() : null;
  let g;
  try {
    // One admitted key per call: a rejected request is never retried under another (unadmitted) ordinal.
    g = await guardPaidCall(d.ledger, spec, { ...step.hooks, maxRejectedRetries: 0 });
  } catch (err) {
    // Release the hold only when the call provably cost nothing (never reached the ledger, or refused with 0).
    const op = await d.ledger.get(forKey);
    if (admission.holdKey && (!op || (op.status === "REFUNDED" && (op.committedUsd ?? 0) === 0))) await d.budget.settleHold(admission.holdKey, "REFUNDED", 0);
    throw err;
  }
  const observed = before !== null && !g.reused ? cents(before - (await d.observeAccountUsd!())) : null;
  const attributed = g.reused ? 0 : Math.max(g.costUsd, observed ?? 0);
  if (admission.holdKey && !g.reused) await d.budget.settleHold(admission.holdKey, "COMMITTED", attributed);
  if (attributed > spec.reservedUsd + EPS) throw new SpendAboveReservationError(name, spec.reservedUsd, attributed);
  return { result: g.result, reused: g.reused, reservedUsd: spec.reservedUsd, attributedUsd: attributed, observedAccountDeltaUsd: observed };
}

/** Calls of THIS plan may be resumed by the gate; any other uncertain call blocks the run. */
async function planFits(d: Pick<Hans01Deps<unknown, { seconds: number }, unknown, unknown>, "budget" | "capUsd">, projectId: string, pendingUsd: number, ownKeys: string[]) {
  const [holds, ops] = await Promise.all([d.budget.listHolds(projectId), d.budget.listOps(projectId)]);
  const exposure = projectExposure(holds, ops);
  const foreign = exposure.uncertainKeys.filter((k) => !ownKeys.includes(k));
  if (foreign.length) throw new ProjectUncertainStateError(foreign);
  if (exposure.usd + pendingUsd > d.capUsd + EPS) throw new ProjectBudgetExceededError(exposure.usd, cents(pendingUsd), d.capUsd);
  return exposure.usd;
}

export async function runHans01<V, A extends { seconds: number }, C, D>(d: Hans01Deps<V, A, C, D>) {
  await d.deliveryPreflight();
  const voiceKey = paidCallKey({ ...d.voice.spec, reservedUsd: ceilCents(d.voice.spec.reservedUsd) }, 0);
  // Only INCREMENTAL work is admitted. A committed voice is recovered for free and the clips are then checked on
  // their own keys (a full replay of a delivered run makes no call and needs no room under the cap). Before the
  // voice exists the clips cannot exist either (their fingerprint is the cut audio), so the allowance applies.
  const voiceOp = await d.ledger.get(voiceKey);
  const allowance = voiceOp?.status === "COMMITTED" ? 0 : ceilCents(d.avatarAllowanceSeconds * d.avatarUsdPerSecond);
  const exposureAtStart = await planFits(d, d.projectId, (voiceOp ? 0 : ceilCents(d.voice.spec.reservedUsd)) + allowance, [voiceKey]);

  const voice = await paidStep(d, "voice", d.voice);
  const audio = await d.cut(voice.result);
  const clipUsd = { apertura: ceilCents(audio.apertura.seconds * d.avatarUsdPerSecond), cierre: ceilCents(audio.cierre.seconds * d.avatarUsdPerSecond) };
  const clipKeys = (["apertura", "cierre"] as const).map((k) => paidCallKey({ ...d.clip(k, audio[k]).spec, reservedUsd: clipUsd[k] }, 0));
  const clipsPending = await Promise.all(clipKeys.map(async (key, i) => ((await d.ledger.get(key)) ? 0 : [clipUsd.apertura, clipUsd.cierre][i])));
  await planFits(d, d.projectId, clipsPending[0] + clipsPending[1], [voiceKey, ...clipKeys]);

  const clips = {} as Record<ClipKey, StepOutcome<C>>;
  for (const k of ["apertura", "cierre"] as const) {
    const s = d.clip(k, audio[k]);
    clips[k] = await paidStep(d, `avatar:${k}`, { spec: { ...s.spec, reservedUsd: clipUsd[k] }, hooks: s.hooks });
  }
  const delivered = await d.deliver({ voice: voice.result, audio, clips: { apertura: clips.apertura.result, cierre: clips.cierre.result } });
  const [holds, ops] = await Promise.all([d.budget.listHolds(d.projectId), d.budget.listOps(d.projectId)]);
  return { voice, audio, clips, delivered, exposureAtStartUsd: exposureAtStart, exposureAtEndUsd: projectExposure(holds, ops).usd };
}
