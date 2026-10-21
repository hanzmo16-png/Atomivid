import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAv, parseDetectors, parseSubtitles, type AvMeasurements, type AvManifest } from "./av-qc";

const ok = (o: Partial<AvMeasurements> = {}): AvMeasurements => ({ probeOk: true, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", pixFmt: "yuv420p", fps: 30,
  formatDuration: 600, videoDuration: 600, audioDuration: 600, hasAudio: true, decodeErrors: [], black: [], freeze: [], silence: [], integratedLufs: -16.2, lra: 7,
  truePeakDbfs: -2, samplePeakDb: -2.5, meanVolumeDb: -22, subtitles: [{ start: 0.2, end: 3, text: "a" }, { start: 3, end: 598, text: "b" }], missingFiles: [], hashMismatches: [], segmentHashes: {}, ...o });
const man: AvManifest = { expected: { width: 1920, height: 1080, durationSeconds: 600, videoCodec: "h264", audioCodec: "aac" }, subtitles: "x.srt",
  timeline: [{ id: "s1", start: 0, end: 300 }, { id: "s2", start: 300, end: 600 }] };
const codes = (r: ReturnType<typeof evaluateAv>) => r.blocking.map((b) => b.code);

test("valid 10-min 1080p passes", () => { const r = evaluateAv(ok(), man); assert.equal(r.verdict, "PASS", JSON.stringify(r.blocking.concat(r.warnings))); });
test("480p presented as 1080p is blocking", () => assert.ok(codes(evaluateAv(ok({ width: 854, height: 480 }), man)).includes("resolution")));
test("3 minutes presented as 10 is blocking", () => assert.ok(codes(evaluateAv(ok({ formatDuration: 180, videoDuration: 180, audioDuration: 180 }), man)).includes("duration")));
test("vertical where 16:9 expected: aspect + resolution", () => { const c = codes(evaluateAv(ok({ width: 1080, height: 1920 }), man)); assert.ok(c.includes("aspect") && c.includes("resolution")); });
test("decode errors, no audio, A/V mismatch", () => {
  assert.ok(codes(evaluateAv(ok({ decodeErrors: ["corrupt frame"] }), man)).includes("decode"));
  assert.ok(codes(evaluateAv(ok({ hasAudio: false, audioCodec: undefined, audioDuration: undefined }), man)).includes("no_audio"));
  assert.ok(codes(evaluateAv(ok({ audioDuration: 590 }), man)).includes("av_length"));
});
test("silence: long unintended silence blocks; intentional one does not", () => {
  assert.ok(codes(evaluateAv(ok({ silence: [[200, 210]] }), man)).includes("silence"));
  const m2: AvManifest = { ...man, timeline: [{ id: "s1", start: 0, end: 199 }, { id: "pause", start: 199, end: 211, intentional: ["silence"] }, { id: "s2", start: 211, end: 600 }] };
  assert.equal(evaluateAv(ok({ silence: [[200, 210]] }), m2).verdict, "PASS");
});
test("black/freeze: unintended blocks; intentional fade passes; short edge fade ignored", () => {
  assert.ok(codes(evaluateAv(ok({ black: [[100, 104]] }), man)).includes("black"));
  assert.ok(codes(evaluateAv(ok({ freeze: [[100, 120]] }), man)).includes("freeze"));
  assert.equal(evaluateAv(ok({ black: [[598.5, 600]] }), man).verdict, "PASS");
  const m2: AvManifest = { ...man, timeline: [{ id: "s1", start: 0, end: 300, intentional: ["freeze"] }, { id: "s2", start: 300, end: 600 }] };
  assert.equal(evaluateAv(ok({ freeze: [[100, 120]] }), m2).verdict, "PASS");
});
test("clipping blocks; loudness off-profile warns", () => {
  assert.ok(codes(evaluateAv(ok({ samplePeakDb: 0 }), man)).includes("clipping"));
  const r = evaluateAv(ok({ integratedLufs: -27 }), man); assert.equal(r.verdict, "PASS_WITH_WARNINGS"); assert.equal(r.warnings[0].code, "loudness");
});
test("subtitles beyond end / cut / overlapping", () => {
  assert.ok(codes(evaluateAv(ok({ subtitles: [{ start: 1, end: 2, text: "a" }, { start: 601, end: 603, text: "b" }] }), man)).includes("subtitles_beyond"));
  assert.ok(codes(evaluateAv(ok({ subtitles: [{ start: 1, end: 2, text: "a" }, { start: 598, end: 605, text: "b" }] }), man)).includes("subtitles_cut"));
  assert.equal(evaluateAv(ok({ subtitles: [{ start: 1, end: 5, text: "a" }, { start: 4, end: 590, text: "b" }] }), man).warnings[0].code, "subtitles_overlap");
});
test("montage: missing file, pending card, gap, short timeline, repeated identity", () => {
  assert.ok(codes(evaluateAv(ok({ missingFiles: ["a.png"] }), man)).includes("missing_file"));
  const pend: AvManifest = { ...man, timeline: [{ id: "s1", start: 0, end: 300, status: "pending" }, { id: "s2", start: 300, end: 600 }] };
  assert.ok(codes(evaluateAv(ok(), pend)).includes("pending_material"));
  const gap: AvManifest = { ...man, timeline: [{ id: "s1", start: 0, end: 290 }, { id: "s2", start: 300, end: 600 }] };
  assert.ok(codes(evaluateAv(ok(), gap)).includes("gap"));
  const short: AvManifest = { ...man, timeline: [{ id: "s1", start: 0, end: 300 }, { id: "s2", start: 300, end: 640 }] };
  assert.ok(codes(evaluateAv(ok(), short)).includes("ending_cut"));
  const rep = evaluateAv(ok({ segmentHashes: { s1: "abc", s2: "abc" } }), man); assert.equal(rep.warnings[0].code, "repeated_material");
  assert.equal(evaluateAv(ok({ segmentHashes: { s1: "abc", s2: "abc" } }), { ...man, allowRepeats: ["s1", "s2"] }).verdict, "PASS");
});
test("parsers: SRT/VTT and ffmpeg detector logs", () => {
  const srt = parseSubtitles("1\n00:00:01,000 --> 00:00:02,500\nHola\n\n2\n00:00:03,000 --> 00:00:04,000\nMundo\n");
  assert.deepEqual(srt.map((c) => [c.start, c.end]), [[1, 2.5], [3, 4]]);
  assert.equal(parseSubtitles("WEBVTT\n\n00:01.000 --> 00:02.000 align:middle\nx\n")[0].end, 2);
  assert.throws(() => parseSubtitles("1\n00:00:xx,000 --> 00:00:02,000\nmal\n"));
  const d = parseDetectors("[blackdetect @ 0x] black_start:1.5 black_end:3.2 black_duration:1.7\n[freezedetect] lavfi.freezedetect.freeze_start: 10\n[freezedetect] lavfi.freezedetect.freeze_end: 14\n[silencedetect] silence_start: 20.5\n[silencedetect] silence_end: 25 | silence_duration: 4.5\n[Parsed_volumedetect] mean_volume: -21.3 dB\n[Parsed_volumedetect] max_volume: -1.2 dB\n[Parsed_ebur128_0 @ 0x] Summary:\n  Integrated loudness:\n    I:         -16.1 LUFS\n  Loudness range:\n    LRA:         6.0 LU\n  True peak:\n    Peak:        -1.0 dBFS\n");
  assert.deepEqual(d.black, [[1.5, 3.2]]); assert.deepEqual(d.freeze, [[10, 14]]); assert.deepEqual(d.silence, [[20.5, 25]]);
  assert.equal(d.integratedLufs, -16.1); assert.equal(d.truePeakDbfs, -1); assert.equal(d.meanVolumeDb, -21.3); assert.equal(d.samplePeakDb, -1.2);
});
