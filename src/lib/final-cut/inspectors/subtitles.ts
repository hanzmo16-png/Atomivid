/** Subtitle inspection: timing, gaps, overlaps, speech window, safe area, readability, truncated final caption. */
import { r2, type MasterEdl } from "../edl";
import type { FinalCutPolicy } from "../policy";
import type { IssueDraft } from "../report";

export function inspectSubtitles(e: MasterEdl, p: FinalCutPolicy): { issues: IssueDraft[]; notAssessable: string[] } {
  const out: IssueDraft[] = [];
  const na: string[] = [];
  const caps = [...e.captions].sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id));
  if (!caps.length) { na.push("subtitles (none attached)"); return { issues: out, notAssessable: na }; }
  const sa = p.subtitles.safeArea;
  caps.forEach((c, i) => {
    const dur = r2(c.endSec - c.startSec);
    const cps = dur > 0 ? c.text.length / dur : Infinity;
    if (dur <= 0 || c.endSec > e.durationSec + 0.01) out.push({ category: "subtitles", rule: "S_TIMING", severity: "major", confidence: 1, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} has an invalid range`, evidence: { startSec: c.startSec, endSec: c.endSec, masterEnd: e.durationSec }, recommendedAction: "retime the caption" });
    else if (dur < p.subtitles.minDisplaySec) out.push({ category: "subtitles", rule: "S_TOO_SHORT", severity: "minor", confidence: 1, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} shows ${dur} s (< ${p.subtitles.minDisplaySec} s)`, evidence: { durationSec: dur }, recommendedAction: "extend the caption" });
    else if (dur > p.subtitles.maxDisplaySec) out.push({ category: "subtitles", rule: "S_TOO_LONG", severity: "minor", confidence: 1, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} shows ${dur} s (> ${p.subtitles.maxDisplaySec} s)`, evidence: { durationSec: dur }, recommendedAction: "split the caption" });
    if (cps > p.subtitles.maxCharsPerSecond) out.push({ category: "subtitles", rule: "S_UNREADABLE", severity: "minor", confidence: 0.95, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} at ${r2(cps)} chars/s (> ${p.subtitles.maxCharsPerSecond})`, evidence: { charsPerSecond: r2(cps) }, recommendedAction: "split or extend the caption" });
    const next = caps[i + 1];
    if (next) {
      if (next.startSec < c.endSec - 0.001) out.push({ category: "subtitles", rule: "S_OVERLAP", severity: "major", confidence: 1, startTime: next.startSec, endTime: c.endSec, shotId: null, description: `captions ${c.id} and ${next.id} overlap`, evidence: { overlapSec: r2(c.endSec - next.startSec) }, recommendedAction: "retime the overlapping caption" });
      else if (next.startSec - c.endSec > p.subtitles.maxGapSec && e.speech.some((s) => s.startSec < next.startSec && s.endSec > c.endSec)) out.push({ category: "subtitles", rule: "S_GAP", severity: "minor", confidence: 0.9, startTime: c.endSec, endTime: next.startSec, shotId: null, description: `${r2(next.startSec - c.endSec)} s without captions while narration continues`, evidence: {}, recommendedAction: "check missing captions" });
    }
    if (e.speech.length) {
      const inside = e.speech.some((s) => c.startSec >= s.startSec - p.subtitles.speechWindowSlackSec && c.endSec <= s.endSec + p.subtitles.speechWindowSlackSec);
      if (!inside) out.push({ category: "subtitles", rule: "S_OUTSIDE_SPEECH", severity: "major", confidence: 0.9, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} is shown outside any speech window`, evidence: { text: c.text.slice(0, 40) }, recommendedAction: "retime to the spoken words" });
    }
    if (c.bottomY !== undefined && (c.bottomY > 1 - sa.bottom || c.bottomY < sa.top)) out.push({ category: "subtitles", rule: "S_SAFE_AREA", severity: "major", confidence: 1, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} outside the vertical safe area`, evidence: { bottomY: c.bottomY }, recommendedAction: "move the caption inside the safe area" });
    if ((c.leftX !== undefined && c.leftX < sa.left) || (c.rightX !== undefined && c.rightX > 1 - sa.right)) out.push({ category: "subtitles", rule: "S_SAFE_AREA", severity: "major", confidence: 1, startTime: c.startSec, endTime: c.endSec, shotId: null, description: `caption ${c.id} outside the horizontal safe area`, evidence: { leftX: c.leftX, rightX: c.rightX }, recommendedAction: "move the caption inside the safe area" });
  });
  const last = caps[caps.length - 1];
  if (last.endSec > e.durationSec - 0.05 && e.speech.length && e.speech[e.speech.length - 1].endSec > e.durationSec + 0.05) out.push({ category: "subtitles", rule: "S_FINAL_TRUNCATED", severity: "major", confidence: 0.9, startTime: last.startSec, endTime: e.durationSec, shotId: null, description: "final caption is cut by the end of the master", evidence: { lastCaptionEnd: last.endSec, masterEnd: e.durationSec }, recommendedAction: "extend the master or retime the final caption" });
  if (!e.speech.length) na.push("captions vs speech window (no speech timing)");
  if (caps.every((c) => c.bottomY === undefined)) na.push("caption safe area (no layout positions)");
  return { issues: out, notAssessable: na };
}
