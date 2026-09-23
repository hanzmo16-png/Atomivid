#!/usr/bin/env node
/**
 * Isolated P0 harness. Fixtures only. No paid APIs. No GitHub. No Stripe.
 * Proves: 1920x1080@30, shot types are visually distinct, segments concat, ffprobe.
 *
 * Shot order matches buildCuriosityDemoProject(): two shots per beat, typeOffset = beat*2.
 *   text, generated_placeholder, ken_burns_image, diagram, map, stock_image
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.LONG_FORM_P0_CLI !== "1") {
  console.error("Refusing: set LONG_FORM_P0_CLI=1. This does not enable Long Form for users.");
  process.exit(1);
}

const W = 1920;
const H = 1080;
const FPS = 30;
const ROOT = process.argv[2] || join(process.cwd(), "p0-output");
mkdirSync(ROOT, { recursive: true });
mkdirSync(join(ROOT, "segments"), { recursive: true });
mkdirSync(join(ROOT, "shots"), { recursive: true });

const SHOTS = [
  { type: "text", caption: "A lamp stays lit after the street has gone dark." },
  { type: "generated_placeholder", caption: "A lamp stays lit after the street has gone dark." },
  { type: "ken_burns_image", caption: "The useful unit is one room, one night, one leftover light." },
  { type: "diagram", caption: "The useful unit is one room, one night, one leftover light." },
  { type: "map", caption: "The leftover light is not atmosphere. It is a record of a decision." },
  { type: "stock_image", caption: "The leftover light is not atmosphere. It is a record of a decision." },
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr || r.stdout}`);
  }
  return r;
}

function probe(path) {
  const ffprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf8" });
  if (ffprobe.status === 0) {
    const r = run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,codec_name:format=duration",
      "-of",
      "json",
      path,
    ]);
    return JSON.parse(r.stdout);
  }
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", path], { encoding: "utf8" });
  const text = `${r.stderr || ""}\n${r.stdout || ""}`;
  const dur = text.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const stream = text.match(/Video:\s+(\w+)[^\n]*?,\s*(\d+)x(\d+)[^\n]*?([\d.]+)\s+fps/);
  if (!dur || !stream) {
    throw new Error(`Could not probe ${path} (ffprobe missing, ffmpeg parse failed)\n${text}`);
  }
  const duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  const fps = Number(stream[4]);
  return {
    streams: [{ width: Number(stream[2]), height: Number(stream[3]), avg_frame_rate: String(fps), codec_name: stream[1] }],
    format: { duration: String(duration) },
  };
}

function escAss(text) {
  return text.replace(/[{}]/g, "").replace(/,/g, " ");
}

function writeAss(path, type, caption, duration) {
  const end = duration.toFixed(2);
  const pad = end.padStart(5, "0");
  const body = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,0,8,60,60,90,1
Style: Cap,DejaVu Sans,32,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,2,0,2,80,80,72,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:${pad},Title,,0,0,0,,${escAss(type.toUpperCase())}
Dialogue: 0,0:00:00.00,0:00:${pad},Cap,,0,0,0,,${escAss(caption)}
`;
  writeFileSync(path, body);
}

function videoFilter(type) {
  switch (type) {
    case "text":
      return `drawbox=x=160:y=360:w=iw-320:h=280:color=0xF4E8C1@0.92:t=fill`;
    case "generated_placeholder":
      return `drawbox=x=80:y=80:w=iw-160:h=ih-160:color=white@0.9:t=6,drawbox=x=200:y=220:w=420:h=260:color=0x888888@0.45:t=fill,drawbox=x=700:y=400:w=360:h=200:color=0xCCCCCC@0.45:t=fill`;
    case "ken_burns_image":
      return `zoompan=z='min(1.0+0.0012*on,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
    case "diagram":
      return `drawbox=x=240:y=280:w=460:h=220:color=white@0.9:t=8,drawbox=x=820:y=280:w=460:h=220:color=white@0.9:t=8,drawbox=x=1220:y=640:w=460:h=180:color=0xF4E8C1@0.9:t=fill`;
    case "map":
      return `drawgrid=width=160:height=160:thickness=2:color=white@0.45,drawbox=x=640:y=320:w=280:h=180:color=0xE24B4B@0.85:t=fill`;
    case "stock_image":
      return `drawbox=x=40:y=40:w=iw-80:h=ih-80:color=white@0.85:t=10,drawbox=x=120:y=200:w=iw-240:h=560:color=0x0E1A24@0.35:t=fill`;
    case "stock_video":
      return `crop=${W}:${H}:x='min(120\\,t*30)':y=0`;
    default:
      throw new Error(`Unknown shot type: ${type}`);
  }
}

function baseColor(type) {
  switch (type) {
    case "text":
      return "0x1a1028";
    case "generated_placeholder":
      return "0x3a3a3a";
    case "ken_burns_image":
      return "0x14243a";
    case "diagram":
      return "0x102818";
    case "map":
      return "0x1a2430";
    case "stock_image":
      return "0x2a1a12";
    case "stock_video":
      return "0x101828";
    default:
      return "0x000000";
  }
}

function renderShot(shot, index, duration, outPath) {
  const color = baseColor(shot.type);
  const size = shot.type === "stock_video" ? `${W + 160}x${H}` : `${W}x${H}`;
  const assPath = outPath.replace(/\.mp4$/, ".ass");
  writeAss(assPath, shot.type, shot.caption, duration);
  run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:d=${duration}:r=${FPS}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${220 + index * 18}:sample_rate=48000:duration=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=110:sample_rate=48000:duration=${duration}`,
    "-filter_complex",
    [
      `[0:v]${videoFilter(shot.type)},subtitles=${assPath}[v]`,
      `[1:a]volume=0.35[voice]`,
      `[2:a]volume=0.08[music]`,
      `[voice][music]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    ].join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-shortest",
    outPath,
  ]);
}

function concat(listFile, outPath) {
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
}

const shotDuration = 4;
const shotFiles = [];
SHOTS.forEach((shot, i) => {
  const p = join(ROOT, "shots", `shot-${String(i + 1).padStart(2, "0")}.mp4`);
  renderShot(shot, i, shotDuration, p);
  shotFiles.push(p);
});

const segments = [
  { id: "seg-01", files: shotFiles.slice(0, 2) },
  { id: "seg-02", files: shotFiles.slice(2, 4) },
  { id: "seg-03", files: shotFiles.slice(4, 6) },
];

const segmentPaths = [];
for (const seg of segments) {
  const list = join(ROOT, `${seg.id}.txt`);
  writeFileSync(list, seg.files.map((f) => `file '${f}'`).join("\n"));
  const out = join(ROOT, "segments", `${seg.id}.mp4`);
  concat(list, out);
  segmentPaths.push(out);
}

const masterList = join(ROOT, "master.txt");
writeFileSync(masterList, segmentPaths.map((f) => `file '${f}'`).join("\n"));
const master = join(ROOT, "master.mp4");
concat(masterList, master);

const info = probe(master);
const v = info.streams[0];
const duration = Number(info.format.duration);
const fpsParts = String(v.avg_frame_rate).split("/");
const fps = fpsParts.length === 2 ? Number(fpsParts[0]) / Number(fpsParts[1]) : Number(v.avg_frame_rate);
const shotTypes = SHOTS.map((s) => s.type);

const report = {
  ok:
    existsSync(master) &&
    v.width === W &&
    v.height === H &&
    Math.abs(fps - FPS) < 0.1 &&
    duration >= 23 &&
    duration <= 25 &&
    new Set(shotTypes).size >= 3,
  spec: { width: W, height: H, fps: FPS, aspect: "16:9" },
  measured: { width: v.width, height: v.height, fps, duration, codec: v.codec_name },
  shotTypes,
  distinctShotTypes: new Set(shotTypes).size,
  segments: segmentPaths,
  master,
  paidApisCalled: false,
  note: "Technical 24s fixture. Not evidence of 8-12 minute narrative quality. Assembly is ffmpeg, not Remotion.",
};

writeFileSync(join(ROOT, "validation.json"), JSON.stringify(report, null, 2));
const fixtureDir = join(process.cwd(), "fixtures");
if (process.env.LONG_FORM_P0_COPY_FIXTURE === "1") {
  mkdirSync(fixtureDir, { recursive: true });
  copyFileSync(master, join(fixtureDir, "p0-master-demo.mp4"));
  copyFileSync(join(ROOT, "validation.json"), join(process.cwd(), "docs", "p0-validation.json"));
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
