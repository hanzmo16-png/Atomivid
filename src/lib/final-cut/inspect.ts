/**
 * inspect(): one deterministic editorial inspection of a MasterEdl. INSPECT_ONLY by nature:
 * it reads the EDL, writes a report, and returns the input fingerprint so a caller can prove
 * the master was untouched. Same EDL + same policy -> byte-identical report (except timestamp).
 */
import { createHash } from "node:crypto";
import { canonicalJson, stableHash } from "../production-intelligence/canonical";
import { r2, slotEnd, slotsSorted, type MasterEdl } from "./edl";
import { FINAL_CUT_POLICY_V1, type FinalCutPolicy } from "./policy";
import { classifyIssue } from "./classify";
import { INSPECTION_VERSION, type EditorialMetrics, type FinalCutReport, type Issue, type RepairClass, type TechnicalMetrics } from "./report";
import { inspectVisual } from "./inspectors/visual";
import { inspectRhythm } from "./inspectors/rhythm";
import { inspectAudio } from "./inspectors/audio";
import { inspectSubtitles } from "./inspectors/subtitles";
import { inspectOpening } from "./inspectors/opening";

export const edlFingerprint = (e: MasterEdl) => createHash("sha256").update(canonicalJson(e)).digest("hex");
const sum = (xs: { startSec: number; endSec: number }[] | null) => (xs === null ? null : r2(xs.reduce((t, x) => t + (x.endSec - x.startSec), 0)));

/** An unreadable caption is auto-fixable only if it can be extended before the next caption starts. */
function readableByExtension(e: MasterEdl, startTime: number | null, p: FinalCutPolicy): boolean {
  const c = e.captions.find((x) => x.startSec === startTime);
  if (!c) return false;
  const next = e.captions.filter((x) => x.id !== c.id && x.startSec >= c.startSec).sort((a, b) => a.startSec - b.startSec)[0];
  const needed = c.text.length / p.subtitles.maxCharsPerSecond;
  return needed <= p.subtitles.maxDisplaySec && (next ? next.startSec : e.durationSec) - c.startSec >= needed;
}

export function inspect(e: MasterEdl, opts: { policy?: FinalCutPolicy; mode?: FinalCutReport["mode"]; now: string; openingMotionRequested?: boolean } ): FinalCutReport {
  const p = opts.policy ?? FINAL_CUT_POLICY_V1;
  const inputSha256 = edlFingerprint(e);
  const v = inspectVisual(e, p), r = inspectRhythm(e, p, opts.openingMotionRequested ?? true), a = inspectAudio(e, p), s = inspectSubtitles(e, p), o = inspectOpening(e, p);
  const slots = slotsSorted(e);
  const issues: Issue[] = [...v.issues, ...r.issues, ...a.issues, ...s.issues, ...o.issues].map((d) => {
    const slot = d.shotId ? slots.find((x) => x.shotId === d.shotId) : undefined;
    const within = d.rule === "V_BLACK_FRAMES" || d.rule === "O_BLACK" ? (d.endTime ?? 0) - (d.startTime ?? 0) <= p.autoFix.maxBlackTrimSec : d.rule === "R_DEAD_AIR" ? (d.endTime ?? 0) - (d.startTime ?? 0) - p.audio.maxSilenceSec <= p.autoFix.maxSilenceTrimSec : d.rule === "A_LOUDNESS" ? Math.abs((e.measured.integratedLufs ?? p.audio.integratedLufsTarget) - p.audio.integratedLufsTarget) <= p.autoFix.loudnessCorrectMaxLu : d.rule === "R_TEXT_CARD_MAX" || d.rule === "O_TITLE_CARD" ? true : d.rule === "S_UNREADABLE" ? readableByExtension(e, d.startTime, p) : undefined;
    return classifyIssue(d, p, { hasValidatedAlternate: !!slot?.validatedAlternates?.length, autoFixWithinTolerance: within });
  }).sort((x, y) => (x.startTime ?? -1) - (y.startTime ?? -1) || x.rule.localeCompare(y.rule) || x.issueId.localeCompare(y.issueId));
  const counts = { AUTO_FIX: 0, SMART_REPAIR: 0, ESCALATE: 0, NONE: 0, blocking: 0, notAssessable: [...v.notAssessable, ...a.notAssessable, ...s.notAssessable] } as FinalCutReport["counts"];
  for (const i of issues) { counts[i.repairClass as RepairClass]++; if (p.blockingSeverities.includes(i.severity)) counts.blocking++; }
  const staticSec = slots.reduce((t, x) => t + (x.motion === "static" ? x.durationSec : 0), 0);
  const total = slots.length ? r2(slotEnd(slots[slots.length - 1])) : 0;
  const editorial: EditorialMetrics = {
    slots: slots.length, averageShotSec: slots.length ? r2(total / slots.length) : null, longestShotSec: slots.length ? Math.max(...slots.map((x) => x.durationSec)) : null,
    longestStaticRunSec: slots.length ? r.stats.longestStaticRunSec : null, staticShare: total ? r2(staticSec / total) : null, motionDensity: total ? r2(1 - staticSec / total) : null,
    transitions: Math.max(0, slots.length - 1), textCardSec: r2(slots.filter((x) => x.kind === "text_card").reduce((t, x) => t + x.durationSec, 0)), blackSec: sum(e.measured.blackIntervals), captions: e.captions.length,
  };
  const technical: TechnicalMetrics = { durationSec: e.durationSec, width: e.width, height: e.height, fps: e.fps, integratedLufs: e.measured.integratedLufs, truePeakDbtp: e.measured.truePeakDbtp, silenceSec: sum(e.measured.silenceIntervals), blackSec: sum(e.measured.blackIntervals), freezeSec: sum(e.measured.freezeIntervals) };
  const reasons: string[] = [];
  let verdict: FinalCutReport["verdict"] = "PASS";
  if (counts.ESCALATE > 0) { verdict = "HUMAN_REVIEW_REQUIRED"; reasons.push(`${counts.ESCALATE} issue(s) need human judgment`); }
  else if (counts.blocking > 0) { verdict = "FAIL"; reasons.push(`${counts.blocking} blocking issue(s)`); }
  else if (counts.AUTO_FIX + counts.SMART_REPAIR > 0) { verdict = "REPAIR_REQUIRED"; reasons.push(`${counts.AUTO_FIX} auto-fixable, ${counts.SMART_REPAIR} need a controlled repair`); }
  else reasons.push("no editorial issue above policy thresholds");
  if (counts.notAssessable.length) reasons.push(`not assessable from this input: ${counts.notAssessable.join("; ")}`);
  const body: Omit<FinalCutReport, "reportId" | "timestamp"> = { inspectionVersion: INSPECTION_VERSION, policyVersion: p.policyVersion, masterId: e.masterId, productionId: e.productionId, source: e.source, mode: opts.mode ?? "INSPECT_ONLY", technical, editorial, opening: o.metrics, issues, counts, verdict, reasons, inputSha256 };
  return { ...body, reportId: "fcr_" + stableHash(body, 20), timestamp: opts.now };
}
