/** Read-only quality checks for e8048599 (music selection + loudness, David in the voice selector). GET-only provider reads. */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { inferTone } from "../src/lib/providers/music/tone";
import { selectMusicTrack } from "../src/lib/providers/music/select";
import { MUSIC_MANIFEST } from "../src/lib/providers/music/manifest";
import { listAccountVoices } from "../src/lib/podcast/voices";
import { reelVoiceChoices } from "../src/lib/video/reel-voices";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const ff = require("@ffmpeg-installer/ffmpeg").path as string;
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  const j = (jobs ?? []).find((x: any) => String(x.id).startsWith("e8048599")) as any;
  const beats = j.editorial_checkpoint.script.beats as { narration: string }[];
  const text = beats.map(b => b.narration).join(" ");
  const tones = inferTone({ style: "documental", topic: j.topic, scriptText: text });
  const sel = selectMusicTrack({ manifest: MUSIC_MANIFEST, tones, seed: j.request_id });
  log("MUSIC_SELECTION", { tones, status: sel.status, track: "track" in sel ? sel.track.id : null, title: "track" in sel ? sel.track.title : null, words: text.split(/\s+/).length });
  mkdirSync("/tmp/m", { recursive: true });
  for (const id of [...new Set(["elevenlabs-cinematic-1", "elevenlabs-inspirational-2", "track" in sel ? sel.track.id : ""].filter(Boolean))]) {
    const t = MUSIC_MANIFEST.find(m => m.id === id)!;
    const { data } = await db.storage.from("music-library").download(t.storagePath);
    if (!data) { log("MUSIC_TRACK", { id, downloaded: false }); continue; }
    const f = `/tmp/m/${id}.mp3`; writeFileSync(f, Buffer.from(await data.arrayBuffer()));
    const out = execFileSync(ff, ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    let err = ""; try { execFileSync(ff, ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] }); } catch (e: any) { err = String(e.stderr ?? ""); }
    const all = out + err;
    const pick = (re: RegExp) => all.match(re)?.[1] ?? null;
    let probe = ""; try { execFileSync(ff, ["-hide_banner", "-i", f], { stdio: ["ignore", "ignore", "pipe"] }); } catch (e: any) { probe = String(e.stderr ?? ""); }
    log("MUSIC_TRACK", { id, title: t.title, tones: t.tones, duration: probe.match(/Duration: ([0-9:.]+)/)?.[1] ?? null, integratedLUFS: pick(/I:\s+(-?[0-9.]+) LUFS/), lra: pick(/LRA:\s+([0-9.]+) LU/), truePeak: pick(/Peak:\s+(-?[0-9.]+) dBFS/) });
  }
  try {
    const voices = await listAccountVoices({ fresh: true });
    const owner = (await db.auth.admin.getUserById(j.user_id)).data.user;
    const choices = reelVoiceChoices(voices, "en", process.env.ELEVENLABS_VOICE_ID || "uYlzyj2kIZo3HfBB21vF", { viewer: owner as any });
    const david = voices.find(v => v.voiceId === "cCYjmrGZaI86GUJ7F2Nn");
    log("VOICE_SELECTOR", { accountVoices: voices.length, davidInAccount: !!david, davidCategory: david?.category ?? null, davidIsOwner: david?.isOwner ?? null, davidPreview: !!david?.previewUrl,
      choices: choices.map(c => `${c.kind}:${c.name}`), davidOffered: choices.some(c => c.voiceId === "cCYjmrGZaI86GUJ7F2Nn") });
  } catch (e) { log("VOICE_SELECTOR", { error: String(e).slice(0, 120) }); }
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
