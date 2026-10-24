/** Read-only verification of the delivered Walton Ep. 2 (no provider call, no write except none). */
import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { elevenLabsSnapshot } from "../src/lib/production-intelligence/capacity/adapters";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const ID = "d1ad0797-4cdb-4694-9d5e-8c57049f2744";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const { data: e } = await db.from("podcast_episodes").select("id,status,title,voice_id,voice_name,characters,estimated_usd,cost_usd,budget_usd,duration_seconds,audio_path,audio_mime,audio_bytes,audio_sha256,loudness,error,run_token,updated_at").eq("id", ID).single();
  const ep = e as Record<string, any>;
  log("EPISODE", { ...ep, audio_path: ep.audio_path ? "<owner>/podcasts/<id>/episode.m4a" : null });
  const { data: blob } = await db.storage.from("videos").download(ep.audio_path);
  const dir = await mkdtemp(path.join(tmpdir(), "wv-")); const f = path.join(dir, "e.m4a");
  await writeFile(f, Buffer.from(await blob!.arrayBuffer()));
  const big = { encoding: "utf8" as const, maxBuffer: 256 * 1024 * 1024 };
  const loud = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], big).stderr;
  const tail = loud.slice(loud.lastIndexOf("Summary:"));
  const silence = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "silencedetect=noise=-45dB:d=3", "-f", "null", "-"], big).stderr.match(/silence_duration: [\d.]+/g) ?? [];
  const streams = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels:format=duration,bit_rate", "-of", "json", f], big).stdout;
  // MP3 derivative (same as src/lib/podcast/audio-export.ts): local, free, no video stream.
  const mp3 = path.join(dir, "e.mp3");
  const conv = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "192k", mp3], big);
  const mp3probe = conv.status === 0 ? spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", mp3], big).stdout : `ffmpeg ${conv.status}`;
  // Playback/download: signed URL with an HTTP Range request (what a browser player does).
  const s = await db.storage.from("videos").createSignedUrl(ep.audio_path, 3600, { download: "walton-ep2.m4a" });
  const r = await fetch(s.data!.signedUrl, { headers: { Range: "bytes=0-1023" } });
  const { data: ops } = await db.from("pi_paid_operations").select("status,reserved_usd,committed_usd,provider,method,created_at").eq("project_id", `podcast-${ID}`);
  const { data: auth } = await db.from("pi_spend_authorizations").select("cap_usd,status,authorization_ref,created_at").eq("project_id", `podcast-${ID}`).single();
  const usage = await db.rpc("pi_spend_authorization_usage", { p_project_id: `podcast-${ID}`, p_exclude_key: null });
  const snap = await elevenLabsSnapshot(fetch, process.env, 0, 0, new Date().toISOString());
  const { data: job } = await db.from("documentary_script_jobs").select("status,error_code,retry_count,run_token").eq("id", "e8048599-cf92-45e8-95c8-f145cb9d3be2").single();
  const resumeAuth = await db.rpc("pi_recovery_resume_authorization", { p_project_id: "x", p_authorization_ref: "x" });
  log("QUALITY", { lufs: /I:\s+(-?[\d.]+) LUFS/.exec(tail)?.[1] ?? null, truePeak: /Peak:\s+(-?[\d.]+) dBFS/.exec(tail.slice(tail.indexOf("True peak")))?.[1] ?? null, lra: /LRA:\s+([\d.]+) LU/.exec(tail)?.[1] ?? null,
    longSilences: silence.length, silences: silence.slice(0, 5), streams: JSON.parse(streams), mp3: typeof mp3probe === "string" && mp3probe.startsWith("{") ? JSON.parse(mp3probe) : mp3probe });
  log("PLAYBACK", { rangeStatus: r.status, contentType: r.headers.get("content-type"), contentRange: r.headers.get("content-range"), disposition: r.headers.get("content-disposition") });
  log("PODCAST", { ledger: ops, authorization: auth, usage: usage.data, elevenlabsCharsNow: snap.available, leonidas: job, resumeAuthRpc: resumeAuth.error ? resumeAuth.error.message : resumeAuth.data });
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 400)); process.exitCode = 1; });
