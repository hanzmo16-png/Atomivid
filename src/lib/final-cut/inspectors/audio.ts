/**
 * Audio inspection over MEASURED values (ffmpeg loudnorm / silencedetect / stem report).
 * Unmeasured values are reported as not assessable, never assumed fine.
 */
import { r2, type MasterEdl } from "../edl";
import type { FinalCutPolicy } from "../policy";
import type { IssueDraft } from "../report";

export function inspectAudio(e: MasterEdl, p: FinalCutPolicy): { issues: IssueDraft[]; notAssessable: string[] } {
  const out: IssueDraft[] = [];
  const na: string[] = [];
  const m = e.measured;
  if (m.integratedLufs === null) na.push("integrated loudness");
  else {
    const delta = r2(m.integratedLufs - p.audio.integratedLufsTarget);
    if (Math.abs(delta) > p.audio.integratedLufsTolerance) out.push({ category: "audio", rule: "A_LOUDNESS", severity: Math.abs(delta) > 6 ? "major" : "minor", confidence: 1, startTime: null, endTime: null, shotId: null, description: `integrated loudness ${m.integratedLufs} LUFS is ${delta > 0 ? "+" : ""}${delta} LU from the ${p.audio.integratedLufsTarget} LUFS target`, evidence: { integratedLufs: m.integratedLufs, target: p.audio.integratedLufsTarget }, recommendedAction: "re-master loudness (loudnorm two-pass)" });
  }
  if (m.truePeakDbtp === null) na.push("true peak");
  else if (m.truePeakDbtp > p.audio.truePeakMaxDbtp) out.push({ category: "audio", rule: "A_TRUE_PEAK", severity: "major", confidence: 1, startTime: null, endTime: null, shotId: null, description: `true peak ${m.truePeakDbtp} dBTP above the ${p.audio.truePeakMaxDbtp} dBTP ceiling`, evidence: { truePeakDbtp: m.truePeakDbtp }, recommendedAction: "apply true-peak limiting / gain correction" });
  if (m.clippingSamples === null) na.push("clipping");
  else if (m.clippingSamples > 0) out.push({ category: "audio", rule: "A_CLIPPING", severity: "major", confidence: 0.95, startTime: null, endTime: null, shotId: null, description: `${m.clippingSamples} clipped samples`, evidence: { clippingSamples: m.clippingSamples }, recommendedAction: "re-master from the un-clipped stems" });
  if (m.silenceIntervals === null) na.push("anomalous silences");
  if (m.voiceOverMusicDb === null) na.push("music over voice (no stem report)");
  else if (m.voiceOverMusicDb < -p.audio.musicOverVoiceDb) out.push({ category: "audio", rule: "A_MUSIC_OVER_VOICE", severity: "major", confidence: 0.85, startTime: null, endTime: null, shotId: null, description: `voice sits ${m.voiceOverMusicDb} dB relative to music (needs at least ${-p.audio.musicOverVoiceDb} dB)`, evidence: { voiceOverMusicDb: m.voiceOverMusicDb }, recommendedAction: "duck the music bed under narration" });
  if (m.fadeInSec === null || m.fadeOutSec === null) na.push("fade in/out");
  else {
    if (m.fadeInSec < p.audio.minFadeSec) out.push({ category: "audio", rule: "A_FADE_IN", severity: "minor", confidence: 0.9, startTime: 0, endTime: p.audio.minFadeSec, shotId: null, description: `fade-in ${m.fadeInSec} s below ${p.audio.minFadeSec} s`, evidence: { fadeInSec: m.fadeInSec }, recommendedAction: "apply the opening fade" });
    if (m.fadeOutSec < p.audio.minFadeSec) out.push({ category: "audio", rule: "A_FADE_OUT", severity: "minor", confidence: 0.9, startTime: r2(e.durationSec - p.audio.minFadeSec), endTime: e.durationSec, shotId: null, description: `fade-out ${m.fadeOutSec} s below ${p.audio.minFadeSec} s`, evidence: { fadeOutSec: m.fadeOutSec }, recommendedAction: "apply the closing fade" });
  }
  // Possible word cuts: a slot boundary at the master's end, or a measured silence, that starts inside a speech segment.
  if (e.speech.length) {
    const cutInside = (t: number) => e.speech.find((s) => t > s.startSec + 0.1 && t < s.endSec - 0.1);
    const s = cutInside(e.durationSec);
    if (s) out.push({ category: "audio", rule: "A_WORD_CUT", severity: "blocking", confidence: 0.8, startTime: e.durationSec, endTime: e.durationSec, shotId: null, description: `the master ends at ${e.durationSec} s inside a speech segment (${s.startSec}-${s.endSec})`, evidence: { segment: s }, recommendedAction: "extend the master to the end of narration" });
    for (const si of m.silenceIntervals ?? []) { const w = cutInside(si.startSec); if (w && si.endSec - si.startSec > 0.5) out.push({ category: "audio", rule: "A_DISCONTINUITY", severity: "major", confidence: 0.7, startTime: si.startSec, endTime: si.endSec, shotId: null, description: `silence starts inside a speech segment (${w.startSec}-${w.endSec}): possible dropout`, evidence: { silence: si, segment: w }, recommendedAction: "re-conform narration audio" }); }
  } else na.push("word cuts / discontinuities (no speech timing)");
  return { issues: out, notAssessable: na };
}
