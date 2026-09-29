/**
 * Media adapter: measured signals from a master file with LOCAL ffmpeg/ffprobe only
 * (blackdetect, freezedetect, silencedetect, loudnorm measurement, astats clipping).
 * Read-only by construction: every command writes to `-f null -`; the input is never
 * modified. Reuses the existing probe, silence and loudness helpers.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeVideoFile, detectAnomalousSilences } from "../../video/long-form/long-form-qc";
import { measureLoudness } from "../../video/audio-master";
import { EDL_VERSION, emptyMeasured, r2, type Interval, type MasterEdl } from "../edl";

const run = promisify(execFile);

export type MediaMeasurement = { probe: { width: number; height: number; fps: number; durationSec: number; hasAudio: boolean }; blackIntervals: Interval[]; freezeIntervals: Interval[]; silenceIntervals: Interval[]; integratedLufs: number | null; truePeakDbtp: number | null; clippingSamples: number | null; commands: string[] };

function parseIntervals(stderr: string, startKey: string, endKey: string): Interval[] {
  const starts = [...stderr.matchAll(new RegExp(`${startKey}:\\s*([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(new RegExp(`${endKey}:\\s*([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  return starts.slice(0, ends.length).map((s, i) => ({ startSec: r2(s), endSec: r2(ends[i]) })).filter((x) => x.endSec > x.startSec);
}

/** All measurements are optional per signal: a failing filter yields null for that signal, never a fake value. */
export async function measureMedia(filePath: string, opts: { minBlackSec?: number; minFreezeSec?: number; minSilenceSec?: number; ffmpegPath?: string } = {}): Promise<MediaMeasurement> {
  const ff = opts.ffmpegPath ?? "ffmpeg";
  const commands: string[] = [];
  const probe = await probeVideoFile(filePath);
  const nullOut = async (vf: string | null, af: string | null) => {
    const args = ["-hide_banner", "-nostats", "-i", filePath, ...(vf ? ["-vf", vf] : ["-vn"]), ...(af ? ["-af", af] : ["-an"]), "-f", "null", "-"];
    commands.push(`${ff} ${args.join(" ")}`);
    try { const r = await run(ff, args, { maxBuffer: 16 * 1024 * 1024, timeout: 600000 }); return r.stderr; } catch (e) { const err = e as { stderr?: string }; return err.stderr ?? ""; }
  };
  const black = parseIntervals(await nullOut(`blackdetect=d=${opts.minBlackSec ?? 0.2}:pic_th=0.98`, null), "black_start", "black_end");
  const freezeRaw = await nullOut(`freezedetect=n=-60dB:d=${opts.minFreezeSec ?? 2}`, null);
  const freeze = parseIntervals(freezeRaw, "freeze_start", "freeze_end");
  let silence: Interval[] = [];
  let lufs: number | null = null, tp: number | null = null, clipping: number | null = null;
  if (probe.hasAudioStream) {
    silence = (await detectAnomalousSilences(filePath, opts.minSilenceSec ?? 1)).map((s) => ({ startSec: r2(s.startSeconds), endSec: r2(s.endSeconds) }));
    try { const m = await measureLoudness(filePath); lufs = m.integratedLufs; tp = m.truePeakDbtp; } catch { /* stays null */ }
    const st = await nullOut(null, "astats=metadata=1:reset=0");
    const clips = [...st.matchAll(/Number of clipped samples:\s*(\d+)/g)].map((m) => Number(m[1]));
    clipping = clips.length ? clips.reduce((a, b) => a + b, 0) : null;
  }
  return { probe: { width: probe.width, height: probe.height, fps: r2(probe.fps), durationSec: r2(probe.durationSeconds), hasAudio: probe.hasAudioStream }, blackIntervals: black, freezeIntervals: freeze, silenceIntervals: silence, integratedLufs: lufs, truePeakDbtp: tp, clippingSamples: clipping, commands };
}

/** EDL from media alone (no edit timeline): slots unknown, measured signals known. */
export function edlFromMeasurement(masterId: string, productionId: string, ref: string, m: MediaMeasurement): MasterEdl {
  return { edlVersion: EDL_VERSION, masterId, productionId, source: { kind: "media", ref }, durationSec: m.probe.durationSec, width: m.probe.width, height: m.probe.height, fps: m.probe.fps, slots: [], speech: [], captions: [], measured: { ...emptyMeasured(), blackIntervals: m.blackIntervals, freezeIntervals: m.freezeIntervals, silenceIntervals: m.silenceIntervals, integratedLufs: m.integratedLufs, truePeakDbtp: m.truePeakDbtp, clippingSamples: m.clippingSamples } };
}

/** Merge measured signals into an edit-timeline EDL (media + edit timeline: the strongest input). */
export function mergeMeasurement(e: MasterEdl, m: MediaMeasurement, ref: string): MasterEdl {
  return { ...e, source: { kind: "media+edit_timeline", ref: `${e.source.ref} + ${ref}` }, durationSec: m.probe.durationSec, width: m.probe.width, height: m.probe.height, fps: m.probe.fps, measured: { ...e.measured, blackIntervals: m.blackIntervals, freezeIntervals: m.freezeIntervals, silenceIntervals: m.silenceIntervals, integratedLufs: m.integratedLufs, truePeakDbtp: m.truePeakDbtp, clippingSamples: m.clippingSamples } };
}
