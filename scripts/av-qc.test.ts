// Integración real con ffmpeg (USD 0): un caso válido y casos rotos generados a propósito. Se omite si no hay ffmpeg.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { measure } from "./av-qc";
import { evaluateAv, type AvManifest } from "@/lib/media-qa/av-qc";

const hasFf = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avqc-"));
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status) throw new Error(String(r.stderr)); };
const V = (vf = "") => ["-f", "lavfi", "-i", `testsrc2=s=640x360:r=25:d=12${vf}`];
const A = (af = "sine=f=440:d=12,volume=0.2") => ["-f", "lavfi", "-i", af];
const ENC = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
const man = (o: Partial<AvManifest> = {}): AvManifest => ({ expected: { width: 640, height: 360, durationSeconds: 12, videoCodec: "h264", audioCodec: "aac" },
  loudness: { integratedLufs: -16, toleranceLu: 40 }, timeline: [{ id: "a", start: 0, end: 6 }, { id: "b", start: 6, end: 12 }], ...o });
const run = (f: string, m: AvManifest) => evaluateAv(measure(path.join(dir, f), m, dir), m);
const codes = (r: ReturnType<typeof evaluateAv>) => r.blocking.map((b) => b.code);

test("valid file passes; broken files fail with the expected code", { skip: !hasFf }, () => {
  ff(...V(), ...A(), ...ENC, path.join(dir, "ok.mp4"));
  fs.writeFileSync(path.join(dir, "ok.srt"), "1\n00:00:00,500 --> 00:00:05,000\nHola\n\n2\n00:00:05,000 --> 00:00:11,500\nAdiós\n");
  const valid = run("ok.mp4", man({ subtitles: "ok.srt" }));
  assert.notEqual(valid.verdict, "FAIL", JSON.stringify(valid.blocking));

  ff("-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=12", ...A(), ...ENC, path.join(dir, "lowres.mp4"));
  assert.ok(codes(run("lowres.mp4", man())).includes("resolution"));

  ff(...V(), ...ENC.filter((x) => x !== "-c:a" && x !== "aac" && x !== "-shortest"), "-an", path.join(dir, "mute.mp4"));
  assert.ok(codes(run("mute.mp4", man())).includes("no_audio"));

  ff(...V(), ...A("sine=f=440:d=12,volume=0.2,volume=enable='between(t,3,10)':volume=0"), ...ENC, path.join(dir, "silence.mp4"));
  assert.ok(codes(run("silence.mp4", man())).includes("silence"));

  ff(...V(",drawbox=enable='between(t,4,8)':c=black:t=fill"), ...A(), ...ENC, path.join(dir, "black.mp4"));
  assert.ok(codes(run("black.mp4", man())).includes("black"));
  assert.ok(!codes(run("black.mp4", man({ timeline: [{ id: "a", start: 0, end: 3.9 }, { id: "fade", start: 3.9, end: 8.1, intentional: ["black"] }, { id: "b", start: 8.1, end: 12 }] }))).includes("black"));

  ff(...V(), ...A("sine=f=440:d=12,volume=12"), ...ENC, path.join(dir, "clip.mp4"));
  assert.ok(codes(run("clip.mp4", man())).includes("clipping"));

  ff(...V(), ...A("sine=f=440:d=6,volume=0.2"), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "short-audio.mp4"));
  assert.ok(codes(run("short-audio.mp4", man())).includes("av_length"));

  const buf = fs.readFileSync(path.join(dir, "ok.mp4")); fs.writeFileSync(path.join(dir, "trunc.mp4"), buf.subarray(0, Math.floor(buf.length * 0.6)));
  const tr = codes(run("trunc.mp4", man())); assert.ok(tr.includes("decode") || tr.includes("probe_failed") || tr.includes("duration"), tr.join(","));

  fs.writeFileSync(path.join(dir, "late.srt"), "1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:11,000 --> 00:00:16,000\nB\n");
  assert.ok(codes(run("ok.mp4", man({ subtitles: "late.srt" }))).includes("subtitles_cut"));
  assert.ok(codes(run("ok.mp4", man({ timeline: [{ id: "a", start: 0, end: 6, file: "nope.png" }, { id: "b", start: 6, end: 12 }] }))).includes("missing_file"));
});
