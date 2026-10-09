/**
 * Read-only review of an already produced video (no generation, no provider call). Technical measures
 * (streams, loudness, silences, black/frozen stretches, cut rate) are printed; frames, the script and
 * the production plan are encrypted to the operator session key (ops/session-public-key.txt).
 */
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, publicEncrypt, randomBytes, constants } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
const WORK = "/tmp/review";
mkdirSync(`${WORK}/frames`, { recursive: true });
mkdirSync("sealed-out", { recursive: true });

function seal(name: string, bytes: Buffer) {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const ek = publicEncrypt({ key: readFileSync("ops/session-public-key.txt", "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync(`sealed-out/${name}.sealed`, [ek, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."));
  log("SEALED_FILE", { name, bytes: bytes.length });
}
const ff = (args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stderr;

async function main(requestId: string) {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw Error("request id expected");
  const { data: r, error } = await db.from("video_requests").select("status,video_path,script_json,long_form_production_plan,duration_seconds,mode,aspect_ratio").eq("id", requestId).single();
  if (error || !r?.video_path) throw Error("video not found");
  const { data: blob } = await db.storage.from("videos").download(r.video_path);
  if (!blob) throw Error("download failed");
  const file = `${WORK}/video.mp4`;
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels", "-of", "json", file]).toString());
  const duration = Number(probe.format.duration);
  log("STREAMS", { seconds: Math.round(duration * 10) / 10, kbps: Math.round(Number(probe.format.bit_rate) / 1000), streams: probe.streams, mode: r.mode, aspect: r.aspect_ratio, requestedSeconds: r.duration_seconds });

  const loud = ff(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const I = loud.match(/I:\s+(-?[\d.]+) LUFS/g)?.at(-1), TP = loud.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.at(-1), LRA = loud.match(/LRA:\s+(-?[\d.]+) LU/g)?.at(-1);
  log("LOUDNESS", { integrated: I, truePeak: TP, range: LRA });
  const sil = ff(["-i", file, "-af", "silencedetect=noise=-45dB:d=1.2", "-f", "null", "-"]);
  const silences = [...sil.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => ({ end: Number(m[1]), seconds: Number(m[2]) }));
  log("SILENCES_OVER_1_2S", { count: silences.length, longest: Math.max(0, ...silences.map((s) => s.seconds)), list: silences.slice(0, 20) });
  const vis = ff(["-i", file, "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=0.003:d=4", "-an", "-f", "null", "-"]);
  log("BLACK_STRETCHES", [...vis.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]));
  log("FROZEN_STRETCHES_OVER_4S", [...vis.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1])));
  const cuts = ff(["-i", file, "-vf", "select='gt(scene,0.30)',showinfo", "-an", "-f", "null", "-"]);
  const cutTimes = [...cuts.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 10) / 10);
  log("CUTS", { count: cutTimes.length, perMinute: Math.round((cutTimes.length / duration) * 60 * 10) / 10, longestShotSeconds: Math.round(Math.max(...[0, ...cutTimes, duration].map((t, i, a) => (i ? t - a[i - 1] : t))) * 10) / 10 });

  // 36 frames at even times, three contact sheets of 12 (4 x 3), timestamps burned for reference.
  const N = 36;
  for (let i = 0; i < N; i++) {
    const t = (duration * (i + 0.5)) / N;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", `scale=480:-2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${Math.floor(t / 60)}\\:${String(Math.floor(t % 60)).padStart(2, "0")}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6`, `${WORK}/frames/f${String(i).padStart(2, "0")}.jpg`]);
  }
  for (let sheet = 0; sheet < 3; sheet++) {
    const files = Array.from({ length: 12 }, (_, k) => `${WORK}/frames/f${String(sheet * 12 + k).padStart(2, "0")}.jpg`);
    execFileSync("montage", [...files, "-tile", "4x3", "-geometry", "+4+4", "-background", "#111", `${WORK}/sheet-${sheet + 1}.jpg`]);
    seal(`sheet-${sheet + 1}.jpg`, readFileSync(`${WORK}/sheet-${sheet + 1}.jpg`));
  }
  // Two full-resolution frames to judge sharpness and subtitle legibility.
  for (const [name, at] of [["full-a", duration * 0.3], ["full-b", duration * 0.7]] as const) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-q:v", "3", `${WORK}/${name}.jpg`]);
    seal(`${name}.jpg`, readFileSync(`${WORK}/${name}.jpg`));
  }
  seal("script-and-plan.json", Buffer.from(JSON.stringify({ script: r.script_json, plan: r.long_form_production_plan, cutTimes, silences })));
}

main(process.argv[2] ?? "").catch((e) => { console.error("REVIEW_FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
