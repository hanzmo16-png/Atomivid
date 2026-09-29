/**
 * AUTO_FIX: deterministic, safe operations on the EDL that need no approval and no paid
 * call. Each operation is a pure function EDL -> EDL, idempotent (applying the plan twice
 * yields the same EDL). Media execution is a separate step (renderOps -> ffmpeg args) that
 * INSPECT_ONLY never runs. Nothing here touches a file.
 */
import { r2, slotEnd, slotsSorted, type Caption, type EdlSlot, type MasterEdl } from "./edl";
import { chooseTransition } from "../production-core/timeline-rules";
import type { FinalCutPolicy } from "./policy";
import type { Issue } from "./report";

export type EdlOperation =
  | { op: "TRIM_BLACK"; issueId: string; startSec: number; endSec: number }
  | { op: "TRIM_SILENCE"; issueId: string; startSec: number; endSec: number; keepSec: number }
  | { op: "SHORTEN_TEXT_CARD"; issueId: string; slotId: string; toSec: number }
  | { op: "SET_TRANSITION"; issueId: string; slotId: string; transition: string }
  | { op: "REMOVE_CAMERA_MOTION"; issueId: string; slotId: string }
  | { op: "SUBSTITUTE_VALIDATED_ASSET"; issueId: string; slotId: string; assetId: string }
  | { op: "LOUDNESS_CORRECT"; issueId: string; gainLu: number; ceilingDbtp: number }
  | { op: "TRUE_PEAK_LIMIT"; issueId: string; ceilingDbtp: number }
  | { op: "APPLY_FADE"; issueId: string; edge: "in" | "out"; seconds: number }
  | { op: "RETIME_CAPTION"; issueId: string; captionId: string; startSec: number; endSec: number }
  | { op: "MOVE_CAPTION_SAFE"; issueId: string; captionId: string };

export type FixPlan = { masterId: string; operations: EdlOperation[]; skipped: { issueId: string; why: string }[] };

/** Build the plan for every AUTO_FIX issue; anything outside tolerance is skipped with a reason (it stays for SMART_REPAIR/ESCALATE). */
export function planAutoFix(e: MasterEdl, issues: Issue[], p: FinalCutPolicy): FixPlan {
  const ops: EdlOperation[] = [];
  const skipped: FixPlan["skipped"] = [];
  const slots = slotsSorted(e);
  const slotOf = (i: Issue) => slots.find((s) => s.shotId === i.shotId) ?? slots.find((s) => i.startTime !== null && i.startTime >= s.startSec && i.startTime < slotEnd(s));
  for (const i of issues.filter((x) => x.repairClass === "AUTO_FIX")) {
    const dur = (i.endTime ?? 0) - (i.startTime ?? 0);
    switch (i.rule) {
      case "V_BLACK_FRAMES": case "O_BLACK": case "R_BLACK_MAX":
        if (dur <= p.autoFix.maxBlackTrimSec) ops.push({ op: "TRIM_BLACK", issueId: i.issueId, startSec: i.startTime!, endSec: i.endTime! }); else skipped.push({ issueId: i.issueId, why: `black ${r2(dur)} s exceeds the ${p.autoFix.maxBlackTrimSec} s auto-trim tolerance` });
        break;
      case "R_DEAD_AIR": {
        const excess = dur - p.audio.maxSilenceSec;
        if (excess <= p.autoFix.maxSilenceTrimSec) ops.push({ op: "TRIM_SILENCE", issueId: i.issueId, startSec: i.startTime!, endSec: i.endTime!, keepSec: p.audio.maxSilenceSec }); else skipped.push({ issueId: i.issueId, why: `silence excess ${r2(excess)} s exceeds the auto-trim tolerance` });
        break;
      }
      case "R_TEXT_CARD_MAX": case "O_TITLE_CARD": {
        const s = slotOf(i) ?? slots.find((x) => x.kind === "text_card" && x.startSec < (i.endTime ?? 0));
        const target = i.rule === "O_TITLE_CARD" ? p.opening.maxTitleCardSec : p.rhythm.maxTextCardSec;
        if (s && s.durationSec - target <= p.autoFix.maxTextCardShortenSec) ops.push({ op: "SHORTEN_TEXT_CARD", issueId: i.issueId, slotId: s.slotId, toSec: target }); else skipped.push({ issueId: i.issueId, why: "text card shortening exceeds the auto-fix tolerance or slot not found" });
        break;
      }
      case "R_TRANSITION_DETERMINISTIC": case "R_TRANSITION_DENSITY": {
        const s = slotOf(i);
        const idx = s ? slots.indexOf(s) : -1;
        if (s && idx > 0) ops.push({ op: "SET_TRANSITION", issueId: i.issueId, slotId: s.slotId, transition: chooseTransition({ ...slots[idx - 1], transitionIn: undefined }, { ...s, transitionIn: undefined }, p.rhythm) }); else skipped.push({ issueId: i.issueId, why: "slot not found" });
        break;
      }
      case "R_CAMERA_MEANINGFUL": { const s = slotOf(i); if (s) ops.push({ op: "REMOVE_CAMERA_MOTION", issueId: i.issueId, slotId: s.slotId }); break; }
      case "V_ASSET_REPETITION": { const s = slotOf(i); if (s?.validatedAlternates?.length) ops.push({ op: "SUBSTITUTE_VALIDATED_ASSET", issueId: i.issueId, slotId: s.slotId, assetId: [...s.validatedAlternates].sort()[0] }); else skipped.push({ issueId: i.issueId, why: "no validated alternate" }); break; }
      case "A_LOUDNESS": { const gain = r2(p.audio.integratedLufsTarget - (e.measured.integratedLufs ?? p.audio.integratedLufsTarget)); if (Math.abs(gain) <= p.autoFix.loudnessCorrectMaxLu) ops.push({ op: "LOUDNESS_CORRECT", issueId: i.issueId, gainLu: gain, ceilingDbtp: p.audio.truePeakMaxDbtp }); else skipped.push({ issueId: i.issueId, why: `${gain} LU exceeds the auto-correction range` }); break; }
      case "A_TRUE_PEAK": ops.push({ op: "TRUE_PEAK_LIMIT", issueId: i.issueId, ceilingDbtp: p.audio.truePeakMaxDbtp }); break;
      case "A_FADE_IN": ops.push({ op: "APPLY_FADE", issueId: i.issueId, edge: "in", seconds: p.audio.minFadeSec }); break;
      case "A_FADE_OUT": ops.push({ op: "APPLY_FADE", issueId: i.issueId, edge: "out", seconds: p.audio.minFadeSec }); break;
      case "S_OVERLAP": {
        const later = e.captions.find((x) => x.startSec === i.startTime), earlier = e.captions.find((x) => x.endSec === i.endTime && x !== later);
        if (!later || !earlier) { skipped.push({ issueId: i.issueId, why: "captions not found" }); break; }
        const start = r2(earlier.endSec);
        if (later.endSec - start >= p.subtitles.minDisplaySec && start - later.startSec <= p.autoFix.maxSubtitleShiftSec) ops.push({ op: "RETIME_CAPTION", issueId: i.issueId, captionId: later.id, startSec: start, endSec: later.endSec }); else skipped.push({ issueId: i.issueId, why: "overlap exceeds the caption shift tolerance" });
        break;
      }
      case "S_TIMING": case "S_TOO_SHORT": case "S_TOO_LONG": case "S_OUTSIDE_SPEECH": case "S_UNREADABLE": case "S_GAP": {
        const c = e.captions.find((x) => x.startSec === i.startTime || (i.endTime !== null && x.endSec === i.endTime)) ?? e.captions.find((x) => i.startTime !== null && x.startSec <= i.startTime && x.endSec >= i.startTime);
        if (!c) { skipped.push({ issueId: i.issueId, why: "caption not found" }); break; }
        const target = retimeCaption(c, e, p);
        if (Math.abs(target.startSec - c.startSec) <= p.autoFix.maxSubtitleShiftSec + p.subtitles.maxDisplaySec && target.endSec > target.startSec) ops.push({ op: "RETIME_CAPTION", issueId: i.issueId, captionId: c.id, ...target }); else skipped.push({ issueId: i.issueId, why: "retime exceeds the caption shift tolerance" });
        break;
      }
      case "S_SAFE_AREA": { const c = e.captions.find((x) => x.startSec === i.startTime); if (c) ops.push({ op: "MOVE_CAPTION_SAFE", issueId: i.issueId, captionId: c.id }); break; }
      default: skipped.push({ issueId: i.issueId, why: `no deterministic operation for ${i.rule}` });
    }
  }
  return { masterId: e.masterId, operations: ops, skipped };
}

/** Deterministic caption retime: clamp into the enclosing speech window and the display bounds. */
function retimeCaption(c: Caption, e: MasterEdl, p: FinalCutPolicy): { startSec: number; endSec: number } {
  const seg = e.speech.find((s) => c.startSec < s.endSec && c.endSec > s.startSec) ?? e.speech.reduce<{ startSec: number; endSec: number } | null>((best, s) => (!best || Math.abs(s.startSec - c.startSec) < Math.abs(best.startSec - c.startSec) ? s : best), null);
  let start = seg ? Math.max(c.startSec, seg.startSec) : c.startSec;
  let end = seg ? Math.min(c.endSec, seg.endSec) : c.endSec;
  const minDur = Math.max(p.subtitles.minDisplaySec, c.text.length / p.subtitles.maxCharsPerSecond);
  if (end - start < minDur) end = start + minDur;
  if (end - start > p.subtitles.maxDisplaySec) end = start + p.subtitles.maxDisplaySec;
  // Never extend into the next caption: a collision is not a repair.
  const next = [...e.captions].filter((x) => x.id !== c.id && x.startSec >= c.startSec).sort((a, b) => a.startSec - b.startSec)[0];
  if (next) end = Math.min(end, next.startSec);
  end = Math.min(end, e.durationSec);
  start = Math.min(start, end - 0.1);
  return { startSec: r2(Math.max(0, start)), endSec: r2(end) };
}

/** Pure application. Time-based ops are applied in descending time order so earlier ranges stay valid. */
export function applyFixPlan(e: MasterEdl, plan: FixPlan): MasterEdl {
  let out: MasterEdl = JSON.parse(JSON.stringify(e));
  const timeOps = plan.operations.filter((o): o is Extract<EdlOperation, { op: "TRIM_BLACK" | "TRIM_SILENCE" }> => o.op === "TRIM_BLACK" || o.op === "TRIM_SILENCE").sort((a, b) => b.startSec - a.startSec);
  for (const o of timeOps) {
    const cutStart = o.op === "TRIM_SILENCE" ? r2(o.startSec + o.keepSec) : o.startSec, cutEnd = o.endSec;
    if (cutEnd <= cutStart) continue;
    // Idempotency guard: the range must still be black/silence in this EDL (already-trimmed ranges no longer exist).
    const list = o.op === "TRIM_BLACK" ? out.measured.blackIntervals : out.measured.silenceIntervals;
    if (!list?.some((x) => x.startSec <= o.startSec + 1e-6 && x.endSec >= o.endSec - 1e-6)) continue;
    out = removeRange(out, cutStart, cutEnd);
  }
  for (const o of plan.operations) {
    if (o.op === "SHORTEN_TEXT_CARD") { const s = out.slots.find((x) => x.slotId === o.slotId); if (s && s.durationSec > o.toSec) out = removeRange(out, r2(s.startSec + o.toSec), slotEnd(s)); }
    else if (o.op === "SET_TRANSITION") { const s = out.slots.find((x) => x.slotId === o.slotId) as (EdlSlot & { transitionIn?: string }) | undefined; if (s) s.transitionIn = o.transition; }
    else if (o.op === "REMOVE_CAMERA_MOTION") { const s = out.slots.find((x) => x.slotId === o.slotId); if (s && s.motion === "camera") s.motion = "static"; }
    else if (o.op === "SUBSTITUTE_VALIDATED_ASSET") { const s = out.slots.find((x) => x.slotId === o.slotId); if (s && s.visualKey !== o.assetId) { s.visualKey = o.assetId; s.validatedAlternates = (s.validatedAlternates ?? []).filter((a) => a !== o.assetId); } }
    else if (o.op === "LOUDNESS_CORRECT") {
      // Idempotent: the target loudness is absolute (measured + gain at plan time); a second application finds it already reached.
      const target = r2((e.measured.integratedLufs ?? 0) + o.gainLu);
      if (out.measured.integratedLufs !== null && out.measured.integratedLufs !== target) {
        const delta = r2(target - out.measured.integratedLufs);
        out.measured.integratedLufs = target;
        if (out.measured.truePeakDbtp !== null) out.measured.truePeakDbtp = Math.min(r2(out.measured.truePeakDbtp + delta), o.ceilingDbtp); // loudnorm limits TP at the ceiling
      }
    }
    else if (o.op === "TRUE_PEAK_LIMIT") { if (out.measured.truePeakDbtp !== null && out.measured.truePeakDbtp > o.ceilingDbtp) out.measured.truePeakDbtp = o.ceilingDbtp; }
    else if (o.op === "APPLY_FADE") { if (o.edge === "in") out.measured.fadeInSec = Math.max(out.measured.fadeInSec ?? 0, o.seconds); else out.measured.fadeOutSec = Math.max(out.measured.fadeOutSec ?? 0, o.seconds); }
    else if (o.op === "RETIME_CAPTION") { const c = out.captions.find((x) => x.id === o.captionId); if (c) { c.startSec = o.startSec; c.endSec = o.endSec; } }
    else if (o.op === "MOVE_CAPTION_SAFE") { const c = out.captions.find((x) => x.id === o.captionId); if (c) { c.bottomY = 0.88; c.leftX = 0.1; c.rightX = 0.9; } }
  }
  return out;
}

/** Remove [a,b) from the timeline: slots, speech, captions and measured intervals shift left. */
function removeRange(e: MasterEdl, a: number, b: number): MasterEdl {
  const len = r2(b - a);
  if (len <= 0) return e;
  const shift = (t: number) => (t <= a ? t : t >= b ? r2(t - len) : a);
  const cutInterval = <T extends { startSec: number; endSec: number }>(x: T): T | null => { const s = shift(x.startSec), en = shift(x.endSec); return en - s > 1e-6 ? { ...x, startSec: s, endSec: en } : null; };
  const slots = e.slots.map((s) => { const st = shift(s.startSec), en = shift(slotEnd(s)); return en - st > 1e-6 ? { ...s, startSec: st, durationSec: r2(en - st) } : null; }).filter((s): s is EdlSlot => !!s);
  const m = e.measured;
  const cutList = (xs: { startSec: number; endSec: number }[] | null) => (xs === null ? null : xs.map(cutInterval).filter((x): x is { startSec: number; endSec: number } => !!x));
  return { ...e, durationSec: r2(e.durationSec - len), slots, speech: e.speech.map(cutInterval).filter((x): x is { startSec: number; endSec: number } => !!x), captions: e.captions.map(cutInterval).filter((x): x is Caption => !!x), measured: { ...m, blackIntervals: cutList(m.blackIntervals), silenceIntervals: cutList(m.silenceIntervals), freezeIntervals: cutList(m.freezeIntervals) } };
}

/** ffmpeg arguments that would realize the media-level ops (documentation of intent; NOT executed by this module). */
export function renderOps(plan: FixPlan): string[] {
  return plan.operations.flatMap((o) => {
    switch (o.op) {
      case "TRIM_BLACK": return [`-vf trim=start=${o.endSec} (or select='not(between(t,${o.startSec},${o.endSec}))'),setpts=N/FRAME_RATE/TB`];
      case "TRIM_SILENCE": return [`-af aselect='not(between(t,${r2(o.startSec + o.keepSec)},${o.endSec}))',asetpts=N/SR/TB`];
      case "LOUDNESS_CORRECT": return [`-af loudnorm=I=<target>:TP=${o.ceilingDbtp}:LRA=11 (two-pass; measured gain ${o.gainLu} LU)`];
      case "TRUE_PEAK_LIMIT": return [`-af alimiter=limit=${o.ceilingDbtp}dB`];
      case "APPLY_FADE": return [o.edge === "in" ? `-af afade=t=in:d=${o.seconds}` : `-af afade=t=out:d=${o.seconds}`];
      default: return [`edl:${o.op}`];
    }
  });
}
