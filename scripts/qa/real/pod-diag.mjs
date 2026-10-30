// Read-only diagnosis (USD 0) of a finished Podcast studio episode, for the studio/host/Recraft improvements:
// spec (participants, voices, avatars, visual settings), result (shots, duration), paid-operations ledger summary,
// the paid artifacts stored for reuse, the owner's avatars and the ElevenLabs voice catalog (GET /v1/voices, free).
// Prints only non-sensitive facts; the full spec, frames and stills go to $EVID (encrypted by the workflow).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID, WORK = process.env.RUNNER_TEMP || "/tmp", ID = process.env.POD_EPISODE_ID || "";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (t, v) => console.log(t, JSON.stringify(v));
fs.mkdirSync(path.join(EVID, "frames"), { recursive: true });
const save = (n, v) => fs.writeFileSync(path.join(EVID, n), typeof v === "string" ? v : JSON.stringify(v, null, 1));

if (!/^[0-9a-f-]{36}$/.test(ID)) { out("ERROR", "POD_EPISODE_ID"); process.exit(1); }
const { data: ep, error } = await db.from("podcast_studio_episodes").select("*").eq("id", ID).single();
if (error || !ep) { out("ERROR", error?.message ?? "not found"); process.exit(1); }
const owner = ep.user_id, spec = ep.spec ?? {};
save("episode.json", ep);
out("EPISODE", { status: ep.status, mode: ep.mode, target: spec.target_minutes, format: spec.format, set: spec.visual?.set, provider: spec.visual?.provider, freq: spec.visual?.avatar_frequency,
  maxSec: spec.visual?.avatar_max_seconds, subtitles: spec.visual?.subtitles, recreations: spec.visual?.recreations, audio: spec.audio_export, scriptChars: (spec.script ?? "").length,
  estimated: ep.estimated_usd, authorized: ep.authorized_usd, cost: ep.cost_usd, duration: ep.result?.duration, lufs: ep.result?.lufs, progress: ep.progress, created: ep.created_at, updated: ep.updated_at, runStarted: ep.run_started_at });
out("PARTICIPANTS", (spec.participants ?? []).map((p) => ({ id: p.id, name: p.name, gender: p.gender, voice: p.voice_id, kind: p.voice_kind, avatar: p.avatar?.kind, avatarId: p.avatar?.avatar_id ?? null, photo: p.avatar?.photo_path ? "yes" : null })));
const shots = ep.result?.shots ?? [];
const byKind = shots.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {});
out("SHOTS", { n: shots.length, byKind, avatarSeconds: Math.round(shots.filter((s) => /avatar|two_shot|over/.test(s.kind)).reduce((n, s) => n + s.end - s.start, 0)) });
const turns = (spec.script ?? "").split("\n").filter((l) => /^[^:]{1,60}:\s*\S/.test(l));
const chars = turns.reduce((n, l) => n + l.replace(/^[^:]{1,60}:\s*/, "").length, 0);
out("SCRIPT", { turns: turns.length, chars, charsPerSecond: ep.result?.duration ? Math.round(chars / (ep.result.duration - 5.5) * 100) / 100 : null });

const { data: ops } = await db.from("podcast_studio_operations").select("key,provider,op,state,reserved_usd,actual_usd,result,created_at").eq("episode_id", ID);
save("ops.json", ops ?? []);
const sum = {}; for (const o of ops ?? []) { const k = `${o.provider}/${o.op}/${o.state}`; sum[k] = sum[k] ?? { n: 0, usd: 0 }; sum[k].n++; sum[k].usd = Math.round((sum[k].usd + Number(o.actual_usd ?? o.reserved_usd ?? 0)) * 1e4) / 1e4; }
out("LEDGER", sum);
const base = `${owner}/podcast-studio/${ID}`;
const list = async (p) => (await db.storage.from("videos").list(p, { limit: 1000 })).data ?? [];
const paid = await list(`${base}/paid`);
out("PAID_FILES", { n: paid.length, mp4: paid.filter((f) => f.name.endsWith(".mp4")).length, mp3: paid.filter((f) => f.name.endsWith(".mp3")).length, png: paid.filter((f) => f.name.endsWith(".png")).length });
out("EPISODE_FILES", (await list(base)).map((f) => ({ name: f.name, bytes: f.metadata?.size ?? null })));

const { data: avs } = await db.from("avatars").select("id,name,provider,provider_avatar_id,source_photo_path,status,created_at").eq("user_id", owner);
out("AVATARS", (avs ?? []).map((a) => ({ id: a.id, name: a.name, status: a.status, ref: String(a.provider_avatar_id ?? "").slice(0, 14), photo: a.source_photo_path ? a.source_photo_path.replace(owner, "<owner>") : null })));
for (const a of avs ?? []) if (a.source_photo_path && a.status === "ready") {
  const { data } = await db.storage.from("avatar-uploads").download(a.source_photo_path);
  if (data) fs.writeFileSync(path.join(EVID, `avatar-${a.name.replace(/\W+/g, "_")}${path.extname(a.source_photo_path)}`), Buffer.from(await data.arrayBuffer()));
}
for (const p of spec.participants ?? []) if (p.avatar?.photo_path) {
  const { data } = await db.storage.from("videos").download(p.avatar.photo_path);
  if (data) fs.writeFileSync(path.join(EVID, `foto-${p.id}${path.extname(p.avatar.photo_path)}`), Buffer.from(await data.arrayBuffer()));
}
const { data: others } = await db.from("podcast_studio_episodes").select("id,title,status,mode,cost_usd,created_at").eq("user_id", owner).order("created_at", { ascending: false }).limit(20);
out("OWNER_STUDIO_EPISODES", (others ?? []).map((e) => ({ id: e.id.slice(0, 8), status: e.status, mode: e.mode, cost: e.cost_usd, at: e.created_at })));

if (process.env.ELEVENLABS_API_KEY) {
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
  const j = await r.json().catch(() => ({}));
  const voices = (j.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category, gender: v.labels?.gender ?? null, accent: v.labels?.accent ?? null, age: v.labels?.age ?? null,
    language: v.labels?.language ?? v.verified_languages?.[0]?.language ?? null, description: v.labels?.description ?? v.description?.slice?.(0, 80) ?? null, use: v.labels?.use_case ?? null, preview: !!v.preview_url }));
  out("VOICES", { http: r.status, n: voices.length });
  for (const v of voices) out("VOICE", v);
}

if (ep.audio_path) {
  const { data } = await db.storage.from("videos").download(ep.audio_path);
  if (data) {
    const a = path.join(EVID, `ep${path.extname(ep.audio_path)}`); fs.writeFileSync(a, Buffer.from(await data.arrayBuffer()));
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", a, "-ar", "16000", "-ac", "1", path.join(WORK, "pod.wav")]);
  }
}
if (ep.video_path) {
  const { data } = await db.storage.from("videos").download(ep.video_path);
  if (data) {
    const f = path.join(WORK, "ep.mp4"); fs.writeFileSync(f, Buffer.from(await data.arrayBuffer()));
    out("VIDEO", JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", f]).toString()));
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "fps=1/6,scale=480:-2", path.join(EVID, "frames", "f%03d.jpg")]);
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "fps=1/6,scale=320:-2,tile=8x8", "-frames:v", "1", path.join(EVID, "contact.jpg")]);
    // Copia reducida del video (540p, CRF 30) para auditar composición y sincronía por segmentos sin superar 100 MB.
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "scale=-2:540", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", path.join(EVID, "ep-540p.mp4")]);
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "fps=1,scale=640:-2", "-q:v", "4", path.join(EVID, "frames", "s%04d.jpg")]);
  }
}
