// Free (USD 0) inspection of the finished Long Form in the owner's account: downloads the stored MP4 OUTSIDE the evidence
// folder (GitHub rejects files > 100 MB), then leaves small, encrypted evidence: probe, frames every 8 s with a contact
// sheet, silence map, the script narration and a 16 kHz track for lf-transcribe.py. Prints only non-sensitive facts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID, WORK = process.env.RUNNER_TEMP || "/tmp", OWNER = process.env.OWNER_ID, REF = process.env.LF_REQUEST_ID || "";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let fails = 0; const facts = {};
const ok = (n, c, i = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${i ? ` — ${i}` : ""}`); if (!c) fails++; return c; };
const done = () => { fs.writeFileSync(path.join(EVID, "inspect.json"), JSON.stringify(facts, null, 1)); console.log(`RESULT lf-inspect: ${fails} FAIL`); process.exit(fails ? 1 : 0); };
fs.mkdirSync(path.join(EVID, "frames"), { recursive: true });

if (!REF.startsWith("hash:")) { ok("request named by hash:<prefix>", false, REF); done(); }
const { data: jobs } = await db.from("documentary_script_jobs").select("request_id").eq("user_id", OWNER).order("created_at", { ascending: false }).limit(200);
const hits = [...new Set((jobs || []).map((x) => x.request_id).filter(Boolean))].filter((id) => crypto.createHash("sha256").update(id).digest("hex").startsWith(REF.slice(5)));
if (!ok("request found (unique) in the owner's account", hits.length === 1, `${hits.length}`)) done();
const R = hits[0];
const { data: r, error: re } = await db.from("video_requests").select("status,video_path,duration_seconds,aspect_ratio,script_json").eq("id", R).single();
facts.request = { status: r?.status, plannedSeconds: r?.duration_seconds, aspect: r?.aspect_ratio ?? null };
if (!ok("request completed with a stored video", r?.status === "completed" && !!r?.video_path, r?.status)) done();

const { data: blob, error } = await db.storage.from("videos").download(r.video_path);
if (!ok("stored video downloadable", !!blob, error?.message ?? "")) done();
const file = path.join(WORK, "lf.mp4"); const buf = Buffer.from(await blob.arrayBuffer()); fs.writeFileSync(file, buf);
facts.file = { bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };

const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration", "-of", "json", file]).toString());
facts.probe = pr; const dur = Number(pr.format.duration);
const vs = pr.streams.find((s) => s.codec_type === "video"), as = pr.streams.find((s) => s.codec_type === "audio");
ok("1920x1080 H.264 + AAC", vs?.width === 1920 && vs?.height === 1080 && vs?.codec_name === "h264" && as?.codec_name === "aac", `${vs?.width}x${vs?.height} ${vs?.r_frame_rate} / ${as?.codec_name} ${as?.sample_rate} Hz`);
ok("duration within the Long Form tolerance (±15 % of the plan)", Math.abs(dur / r.duration_seconds - 1) <= 0.15, `${dur.toFixed(1)} s / plan ${r.duration_seconds} s`);
ok("audio and video tracks end together (±0.5 s)", Math.abs(Number(vs?.duration ?? dur) - Number(as?.duration ?? dur)) <= 0.5, `video ${vs?.duration} / audio ${as?.duration}`);

spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "fps=1/8,scale=480:-2", path.join(EVID, "frames", "f%03d.jpg")]);
spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "fps=1/8,scale=320:-2,tile=6x6", "-frames:v", "1", path.join(EVID, "contact.jpg")]);
facts.frames = fs.readdirSync(path.join(EVID, "frames")).length;
const fr = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vf", "blackdetect=d=1:pix_th=0.10,freezedetect=n=0.003:d=12", "-an", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
facts.black = (fr.match(/black_start:[\d.]+ black_end:[\d.]+/g) || []); facts.frozen = (fr.match(/freeze_start: [\d.]+|freeze_duration: [\d.]+/g) || []);
ok("no black gaps ≥ 1 s", facts.black.length === 0, JSON.stringify(facts.black));
ok("no frozen picture ≥ 12 s", facts.frozen.length === 0, JSON.stringify(facts.frozen));
const si = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-38dB:d=2.5", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
facts.silences = [...si.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
ok("no silence ≥ 2.5 s in the audio mix", facts.silences.length === 0, JSON.stringify(facts.silences));

const beats = Array.isArray(r.script_json?.beats) ? r.script_json.beats : [];
const narration = beats.map((b) => String(b?.narration ?? "")).join("\n");
facts.script = { beats: beats.length, scenes: beats.reduce((a, b) => a + (Array.isArray(b?.visuals) ? b.visuals.length : 0), 0), narrationWords: narration.split(/\s+/).filter(Boolean).length };
fs.writeFileSync(path.join(EVID, "narration.txt"), narration);
fs.writeFileSync(path.join(EVID, "scenes.json"), JSON.stringify(beats.map((b, i) => ({ beat: i, narration: b?.narration, visuals: (b?.visuals || []).map((v) => v?.description) })), null, 1));
// Informe visual que el worker guardó antes del render (solo lectura): qué recurso cubre cada escena, su descripción
// del proveedor y los términos que coincidieron. Permite revisar a ojo los fotogramas contra lo que el filtro aceptó.
const { data: vr } = await db.storage.from("videos").download(`${R}/state/visual-report.json`);
if (vr) {
  const rep = JSON.parse(Buffer.from(await vr.arrayBuffer()).toString());
  const scenes = (rep.scenes || []).map((s) => ({ start: s.startSec, end: s.endSec, intent: s.intent?.description, subject: s.intent?.subject, place: s.intent?.place,
    source: s.source ?? s.asset?.source ?? null, provider: s.provider ?? s.asset?.provider ?? null, description: s.candidateDescription ?? s.description ?? s.asset?.description ?? null,
    relevance: s.relevance ?? null, matchedTerms: s.matchedTerms ?? null }));
  fs.writeFileSync(path.join(EVID, "visual-report.json"), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(EVID, "visual-scenes.json"), JSON.stringify(scenes, null, 1));
  console.log(`INFO visual report: ${scenes.length} scenes`);
} else console.log("INFO visual report: not stored");
spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", path.join(WORK, "lf.wav")]);
done();
