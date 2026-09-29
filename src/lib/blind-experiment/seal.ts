/**
 * Human baseline seal: an immutable, content-addressed snapshot of the human answer.
 * After sealing, answers are never edited; corrections are amendments appended to a
 * hash chain, and the evaluator always scores the ORIGINAL sealed answers.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../production-intelligence/canonical";
import { HumanBaselineSchema, ANSWER_FIELDS, INPUT_FIELDS, type HumanBaseline, type HumanBaselineInput } from "./schema";

export const SEAL_VERSION = "blind-seal/1";
export const sha256 = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : canonicalJson(v)).digest("hex");

export class BaselineTamperedError extends Error {}
export class SealError extends Error {}

export type SealSummary = { shots: number; plannedGenerativeClips: number; plannedGenerativeSeconds: number; plannedGenerativeSecondsPerMinute: number; expectedCostUsd: number };
export type SealedBaseline = {
  sealVersion: typeof SEAL_VERSION;
  baselineId: string;
  HUMAN_BASELINE_SEALED: true;
  protocolVersion: string;
  protocolSha256: string;
  commitSha: string;
  sealedAt: string;
  contentHashes: { baseline: string; shotInputs: string; humanAnswers: string; research: string; script: string; storyboard: string };
  summary: SealSummary;
  baseline: HumanBaseline;
  sealHash: string;
};

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function summarize(b: HumanBaseline): SealSummary {
  const gen = b.shots.filter((s) => s.humanWouldGenerateVideo);
  const secs = gen.reduce((t, s) => t + s.i2vPlan!.durationSeconds, 0);
  return { shots: b.shots.length, plannedGenerativeClips: gen.length, plannedGenerativeSeconds: secs, plannedGenerativeSecondsPerMinute: r4(secs / (b.finishedSeconds / 60)), expectedCostUsd: r4(gen.reduce((t, s) => t + s.i2vPlan!.estimatedCostUsd, 0)) };
}

function payloadHash(s: Omit<SealedBaseline, "sealHash">): string { return sha256(s); }

export function sealBaseline(input: HumanBaselineInput, o: { protocol: { protocolVersion: string }; commitSha: string; sealedAt: string }): SealedBaseline {
  const parsed = HumanBaselineSchema.safeParse(input);
  if (!parsed.success) throw new SealError("baseline incomplete or invalid: " + parsed.error.issues.map((i) => i.message).join("; "));
  // Canonical order: the same baseline always hashes the same, whatever order the shots were typed in.
  const baseline: HumanBaseline = { ...parsed.data, shots: [...parsed.data.shots].sort((a, b) => a.timelineOrder - b.timelineOrder) };
  if (baseline.protocolVersion !== o.protocol.protocolVersion) throw new SealError(`baseline declares ${baseline.protocolVersion}, protocol is ${o.protocol.protocolVersion}`);
  if (!/^[0-9a-f]{7,40}$/.test(o.commitSha)) throw new SealError("commitSha must be a git SHA");
  const shots = baseline.shots;
  const contentHashes = {
    baseline: sha256(baseline),
    shotInputs: sha256(shots.map((s) => pick(s, INPUT_FIELDS))),
    humanAnswers: sha256(shots.map((s) => ({ shotId: s.shotId, ...pick(s, ANSWER_FIELDS) }))),
    research: baseline.documents.research.sha256,
    script: baseline.documents.script.sha256,
    storyboard: baseline.documents.storyboard.sha256,
  };
  const body: Omit<SealedBaseline, "sealHash"> = {
    sealVersion: SEAL_VERSION, baselineId: `${baseline.projectId}-bl-${contentHashes.baseline.slice(0, 12)}`, HUMAN_BASELINE_SEALED: true,
    protocolVersion: o.protocol.protocolVersion, protocolSha256: sha256(o.protocol), commitSha: o.commitSha, sealedAt: o.sealedAt,
    contentHashes, summary: summarize(baseline), baseline,
  };
  return deepFreeze({ ...body, sealHash: payloadHash(body) });
}

/** Recomputes every hash: any edit to the sealed file (e.g. a human answer) is detected. */
export function verifySeal(s: SealedBaseline): void {
  if (!s || s.HUMAN_BASELINE_SEALED !== true || s.sealVersion !== SEAL_VERSION) throw new BaselineTamperedError("not a sealed baseline");
  const { sealHash, ...body } = s;
  if (payloadHash(body) !== sealHash) throw new BaselineTamperedError("seal hash mismatch: the sealed baseline was modified");
  if (sha256(s.baseline) !== s.contentHashes.baseline) throw new BaselineTamperedError("baseline content hash mismatch");
  const shots = [...s.baseline.shots].sort((a, b) => a.timelineOrder - b.timelineOrder);
  if (sha256(shots.map((x) => ({ shotId: x.shotId, ...pick(x, ANSWER_FIELDS) }))) !== s.contentHashes.humanAnswers) throw new BaselineTamperedError("human answers were modified after the seal");
}

// ---------- amendments (append-only hash chain; the sealed baseline is never touched) ----------
export type Amendment = { seq: number; baselineId: string; shotId: string; field: string; from: unknown; to: unknown; reason: string; author: string; at: string; prevHash: string; hash: string };

export function amend(sealed: SealedBaseline, log: readonly Amendment[], a: { shotId: string; field: string; to: unknown; reason: string; author: string; at: string }): readonly Amendment[] {
  verifySeal(sealed); verifyAmendments(sealed, log);
  if (!a.reason.trim() || !a.author.trim()) throw new SealError("an amendment needs a reason and an author");
  const current = effectiveBaseline(sealed, log).shots.find((s) => s.shotId === a.shotId);
  if (!current) throw new SealError(`unknown shot ${a.shotId}`);
  if (!(a.field in current)) throw new SealError(`unknown field ${a.field}`);
  const prevHash = log.length ? log[log.length - 1].hash : sealed.sealHash;
  const body = { seq: log.length + 1, baselineId: sealed.baselineId, shotId: a.shotId, field: a.field, from: (current as Record<string, unknown>)[a.field], to: a.to, reason: a.reason, author: a.author, at: a.at, prevHash };
  return deepFreeze([...log, { ...body, hash: sha256(body) }]);
}

export function verifyAmendments(sealed: SealedBaseline, log: readonly Amendment[]): void {
  let prev = sealed.sealHash;
  log.forEach((x, i) => {
    const { hash, ...body } = x;
    if (x.seq !== i + 1 || x.prevHash !== prev || sha256(body) !== hash || x.baselineId !== sealed.baselineId) throw new BaselineTamperedError(`amendment chain broken at #${i + 1}`);
    prev = hash;
  });
}

/** Baseline with amendments applied: REPORTING ONLY. Scoring always uses sealed.baseline. */
export function effectiveBaseline(sealed: SealedBaseline, log: readonly Amendment[]): HumanBaseline {
  const b = JSON.parse(JSON.stringify(sealed.baseline)) as HumanBaseline;
  for (const x of log) { const s = b.shots.find((y) => y.shotId === x.shotId) as Record<string, unknown> | undefined; if (s) s[x.field] = x.to; }
  return b;
}
