/**
 * Podcast 2.0 — render SIMULADO (USD 0, sin red). TTS local espeak-ng (2 voces distintas) + ffmpeg.
 *   npx tsx scripts/podcast-2-0/render.ts <B|C|D|E> <outDir>
 * B = narrador único ~15 min · C = diálogo A/B ~10 min · D = mixto (audio propio A + B sintético, reemplazo de 1 turno) · E = recuperación
 */
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { spawnSync } from "node:child_process";
import { directSegments, type DirectionPlan, type DirectInput } from "@/lib/podcast/v2/director";
import { Conversation, dialogueIssues } from "@/lib/podcast/v2/conversation";
import { planMusic, musicIssues, LOUDNESS, type MusicTrack } from "@/lib/podcast/v2/music";
import { segmentKey, synthOnce, type CacheEntry, type DurableStore } from "@/lib/podcast/v2/cost-cache";
import { editorialQc } from "@/lib/podcast/v2/qc";
import { conversationFixture, narrationFixture } from "./fixtures";

const sh = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(" ")}…\n${r.stderr?.slice(-800)}`); return r.stdout; };
const dur = (f: string) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const MUSIC_DIR = process.env.PODCAST_MUSIC_DIR ?? "/workspace/reels-libro/musica";
const LIB: MusicTrack[] = [
  { file: "Volatile_Reaction.mp3", title: "Volatile Reaction", artist: "Kevin MacLeod", license: "CC BY 4.0", source_url: "https://incompetech.com", moods: ["suspense", "revelation"] },
  { file: "Heroic_Age.mp3", title: "Heroic Age", artist: "Kevin MacLeod", license: "CC BY 4.0", source_url: "https://incompetech.com", moods: ["enthusiasm"] },
  { file: "Crusade.mp3", title: "Crusade", artist: "Kevin MacLeod", license: "CC BY 4.0", source_url: "https://incompetech.com", moods: ["calm", "reflection"] },
];
const licensedFiles = () => { const t = fs.existsSync(path.join(MUSIC_DIR, "LICENSES.md")) ? fs.readFileSync(path.join(MUSIC_DIR, "LICENSES.md"), "utf8") : ""; return new Set(LIB.filter(l => t.includes(l.file) && fs.existsSync(path.join(MUSIC_DIR, l.file))).map(l => l.file)); };

export class FileStore implements DurableStore {
  constructor(private f: string) {}
  private read(): Record<string, CacheEntry> { return fs.existsSync(this.f) ? JSON.parse(fs.readFileSync(this.f, "utf8")) : {}; }
  get(k: string) { return this.read()[k]; }
  put(e: CacheEntry) { const d = this.read(); d[e.key] = e; fs.writeFileSync(this.f + ".tmp", JSON.stringify(d, null, 1)); fs.renameSync(this.f + ".tmp", this.f); }
  all() { return Object.values(this.read()); }
}

const VOICE = { A: ["-v", "es-419", "-p", "30"], B: ["-v", "es+f3", "-p", "62"] } as Record<string, string[]>;
export const counters = { synth: 0 };

async function synthAll(plan: DirectionPlan, out: string, owner: string, store: DurableStore, uploads: Record<string, string> = {}, failOn?: string) {
  const files: Record<string, string> = {};
  for (const s of plan.segments) {
    if (uploads[s.segment_id]) { files[s.segment_id] = uploads[s.segment_id]; continue; } // audio propio: se usa tal cual, sin TTS
    const key = segmentKey({ owner_id: owner, voice_id: s.voice_id, model: s.model, text: s.text, settings: s.native });
    const r = await synthOnce(store, { key, owner_id: owner, usd: 0, capUsd: 0 }, async (k) => {
      if (failOn === s.segment_id) throw new Error("TIMEOUT_SIMULADO");
      counters.synth++;
      const wav = path.join(out, "seg", `${k.slice(0, 16)}.wav`);
      sh("espeak-ng", [...VOICE[s.speaker_id] ?? VOICE.A, "-s", String(Math.round(165 * s.pace)), "-w", wav + ".raw.wav", s.text]);
      sh("ffmpeg", ["-y", "-v", "error", "-i", wav + ".raw.wav", "-ar", "48000", "-ac", "1", wav]); fs.rmSync(wav + ".raw.wav");
      return { file: wav };
    });
    files[s.segment_id] = r.file;
  }
  return files;
}

const srtTime = (ms: number) => { const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(Math.floor(ms % 1000)).padStart(3, "0")}`; };

async function produce(name: string, inputs: DirectInput[], out: string, opts: { targetMinutes: number; labels: Record<string, string>; uploads?: Record<string, string>; failOn?: string; owner?: string }) {
  fs.mkdirSync(path.join(out, "seg"), { recursive: true }); fs.mkdirSync(path.join(out, "img"), { recursive: true });
  const store = new FileStore(path.join(out, "cache.json"));
  const plan = directSegments(inputs);
  const files = await synthAll(plan, out, opts.owner ?? "owner-sim", store, opts.uploads, opts.failOn);
  // timeline + subtítulos + imágenes
  const list: string[] = [], srt: string[] = [], imgList: string[] = [], timeline: { id: string; start: number; end: number; speaker: string; intentional: ("freeze")[] }[] = [];
  let t = 0; const subtitles: { speaker: string; text: string }[] = [];
  const sil = (ms: number) => { const f = path.join(out, "seg", `sil${ms}.wav`); if (!fs.existsSync(f)) sh("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(ms / 1000), f]); return f; };
  plan.segments.forEach((s, i) => {
    s.actual_duration_ms = Math.round(dur(files[s.segment_id]) * 1000);
    const start = t + s.pause_before_ms, end = start + s.actual_duration_ms;
    list.push(sil(s.pause_before_ms), files[s.segment_id], sil(s.pause_after_ms));
    srt.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n[${opts.labels[s.speaker_id]}] ${s.text}\n`);
    subtitles.push({ speaker: s.speaker_id, text: s.text });
    const segTotal = s.pause_before_ms + s.actual_duration_ms + s.pause_after_ms;
    const img = path.join(out, "img", `${String(i).padStart(3, "0")}.png`);
    const color = s.speaker_id === "A" ? "0x1d3557" : "0x6a040f";
    const label = `${opts.labels[s.speaker_id]} habla · ${s.emotion}`.replace(/[:']/g, " ");
    sh("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1", "-vf",
      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${label}':x=24:y=24:fontsize=24:fontcolor=white,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='SIMULACION USD 0 · seg ${i + 1}/${plan.segments.length}':x=24:y=64:fontsize=16:fontcolor=0xdddddd,drawbox=x=${s.speaker_id === "A" ? 40 : 360}:y=120:w=240:h=150:color=white@0.85:t=fill`, img]);
    imgList.push(`file '${img}'\nduration ${(segTotal / 1000).toFixed(3)}`);
    timeline.push({ id: s.segment_id, start: t / 1000, end: (t + segTotal) / 1000, speaker: s.speaker_id, intentional: ["freeze"] });
    t += segTotal;
  });
  imgList.push(`file '${path.join(out, "img", `${String(plan.segments.length - 1).padStart(3, "0")}.png`)}'`);
  fs.writeFileSync(path.join(out, "voice.txt"), list.map(f => `file '${f}'`).join("\n"));
  fs.writeFileSync(path.join(out, "images.txt"), imgList.join("\n"));
  fs.writeFileSync(path.join(out, `${name}.srt`), srt.join("\n"));
  sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(out, "voice.txt"), "-c", "pcm_s16le", path.join(out, "voice.wav")]);
  // música
  const lic = licensedFiles(); const cues = planMusic(plan, LIB);
  const parts: string[] = [];
  cues.forEach((c, i) => {
    const d = (c.end_ms - c.start_ms) / 1000, f = path.join(out, "seg", `music${i}.wav`);
    if (!c.track || !lic.has(c.track)) sh("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(d), f]);
    else sh("ffmpeg", ["-y", "-v", "error", "-stream_loop", "-1", "-i", path.join(MUSIC_DIR, c.track), "-t", String(d), "-ac", "1", "-ar", "48000",
      "-af", `volume=${c.bed_db}dB,afade=t=in:d=${Math.min(c.fade_in_ms / 1000, d / 3)},afade=t=out:st=${Math.max(0, d - Math.min(c.fade_out_ms / 1000, d / 3))}:d=${Math.min(c.fade_out_ms / 1000, d / 3)}`, f]);
    parts.push(f);
  });
  fs.writeFileSync(path.join(out, "music.txt"), parts.map(f => `file '${f}'`).join("\n"));
  sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(out, "music.txt"), path.join(out, "music.wav")]);
  sh("ffmpeg", ["-y", "-v", "error", "-i", path.join(out, "voice.wav"), "-i", path.join(out, "music.wav"), "-filter_complex",
    `[0:a]asplit=2[v][sc];[1:a][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[m];[v][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=${LOUDNESS.integrated_lufs}:TP=-2.5:LRA=11,alimiter=limit=0.8:level=false[a]`,
    "-map", "[a]", "-ar", "48000", path.join(out, "mix.wav")]);
  const srtPath = path.join(out, `${name}.srt`).replace(/:/g, "\\:");
  const mp4 = path.join(out, `${name}.mp4`);
  sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(out, "images.txt"), "-i", path.join(out, "mix.wav"),
    "-vf", `fps=12,format=yuv420p,subtitles=${srtPath}:force_style='FontSize=14,MarginV=18'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-tune", "stillimage",
    "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", mp4]);
  const manifest = { version: 1, expected: { width: 640, height: 360, durationSeconds: t / 1000, durationTolerancePct: 3, videoCodec: "h264", audioCodec: "aac", requireAudio: true },
    loudness: { integratedLufs: LOUDNESS.integrated_lufs, toleranceLu: LOUDNESS.tolerance, truePeakDbtp: LOUDNESS.true_peak_max_db }, subtitles: `${name}.srt`,
    timeline: timeline.map(x => ({ id: x.id, start: x.start, end: x.end, kind: `speaker-${x.speaker}`, intentional: x.intentional })) };
  fs.writeFileSync(path.join(out, `${name}.manifest.json`), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(out, `${name}.plan.json`), JSON.stringify(plan, null, 1));
  const qc = { editorial: editorialQc(plan, { targetMinutes: opts.targetMinutes, images: imgList, subtitles }), music: musicIssues(cues, lic), cues, durationSec: t / 1000, synthCalls: counters.synth };
  fs.writeFileSync(path.join(out, `${name}.qc.json`), JSON.stringify(qc, null, 1));
  // contact sheet
  sh("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", `fps=${Math.max(1, 16) / Math.max(16, t / 1000)},scale=320:-1,tile=4x4`, "-frames:v", "1", path.join(out, `${name}.contact.png`)]);
  return { plan, mp4, qc, files };
}

const convInputs = (c: ReturnType<typeof conversationFixture>): DirectInput[] => c.turns.map(t => ({ segment_id: t.turn_id, speaker_id: t.speaker, text: t.text, voice_id: t.speaker === "A" ? (c.participants[0].voice_id ?? "own-recording-A") : c.participants[1].voice_id!, provider: t.speaker === "A" && c.participants[0].source === "own_recording" ? "own_recording" : "mock", model: "mock-espeak" }));

async function main() {
  const [scn, outArg] = process.argv.slice(2); const out = path.resolve(outArg ?? `/workspace/podcast-2-0/out/${scn}`);
  fs.mkdirSync(out, { recursive: true });
  const labels = { A: "A", B: "B" };
  if (scn === "B") {
    const r = await produce("B-narrador-15min", narrationFixture().map(s => ({ segment_id: s.id, speaker_id: "A", text: s.text, voice_id: "mock-voice-a", provider: "mock" as const, model: "mock-espeak" })), out, { targetMinutes: 15, labels: { A: "Narrador" } });
    console.log(JSON.stringify({ mp4: r.mp4, dur: r.qc.durationSec, synth: counters.synth }));
  } else if (scn === "C") {
    const c = Conversation.parse(conversationFixture());
    fs.writeFileSync(path.join(out, "conversation.json"), JSON.stringify(c, null, 1));
    const issues = dialogueIssues(c);
    const r = await produce("C-dialogo", convInputs(c), out, { targetMinutes: 10, labels });
    console.log(JSON.stringify({ mp4: r.mp4, dur: r.qc.durationSec, synth: counters.synth, dialogueIssues: issues }));
  } else if (scn === "D") {
    const c = Conversation.parse(conversationFixture({ A: "own_recording", B: "mock" }));
    // «Grabación propia» de A: archivos subidos (fixture local generado UNA vez, distinto del TTS de la sesión)
    const up = path.join(out, "uploads"); fs.mkdirSync(up, { recursive: true });
    const uploads: Record<string, string> = {};
    for (const t of c.turns.filter(t => t.speaker === "A")) { const f = path.join(up, `${t.turn_id}.wav`); if (!fs.existsSync(f)) { sh("espeak-ng", ["-v", "es", "-p", "25", "-s", "155", "-w", f + ".r.wav", t.text]); sh("ffmpeg", ["-y", "-v", "error", "-i", f + ".r.wav", "-ar", "48000", "-ac", "1", f]); fs.rmSync(f + ".r.wav"); } uploads[t.turn_id] = f; }
    const before = Object.fromEntries(Object.entries(uploads).map(([k, f]) => [k, sha(f)]));
    const r1 = await produce("D-mixto", convInputs(c), out, { targetMinutes: 10, labels: { A: "A (voz propia)", B: "B" }, uploads });
    const synth1 = counters.synth;
    // reemplazar un turno de B sin regenerar el resto
    const bIdx = c.turns.findIndex(t => t.speaker === "B" && t.kind === "reaction");
    c.turns[bIdx] = { ...c.turns[bIdx], text: "Cambio editorial: esta reacción de B se reemplazó sin regenerar nada más." };
    counters.synth = 0;
    const r2 = await produce("D-mixto-reemplazo", convInputs(c), out, { targetMinutes: 10, labels: { A: "A (voz propia)", B: "B" }, uploads });
    const after = Object.fromEntries(Object.entries(uploads).map(([k, f]) => [k, sha(f)]));
    const untouched = Object.keys(before).every(k => before[k] === after[k]);
    console.log(JSON.stringify({ mp4: [r1.mp4, r2.mp4], synthFirst: synth1, synthAfterReplace: counters.synth, ownAudioUnchanged: untouched, ttsForA: 0 }));
  } else if (scn === "E") {
    const c = Conversation.parse(conversationFixture());
    const inputs = convInputs(c).slice(0, 12);
    let firstErr = "";
    try { await produce("E-rec", inputs, out, { targetMinutes: 1, labels, failOn: inputs[5].segment_id }); } catch (e) { firstErr = (e as Error).message; }
    const s1 = counters.synth; counters.synth = 0;
    let secondErr = ""; try { await produce("E-rec", inputs, out, { targetMinutes: 1, labels }); } catch (e) { secondErr = (e as Error).message; }
    const s2 = counters.synth;
    // reconciliación explícita del operador (proveedor confirma «no facturado») → luego reanuda
    const store = new FileStore(path.join(out, "cache.json"));
    for (const e of store.all()) if (e.state === "ambiguous") store.put({ ...e, state: "failed_unbilled" });
    const dataBefore = store.all().filter(e => e.state === "paid").length;
    for (const e of store.all()) if (e.state === "failed_unbilled") { const d = JSON.parse(fs.readFileSync(path.join(out, "cache.json"), "utf8")); delete d[e.key]; fs.writeFileSync(path.join(out, "cache.json"), JSON.stringify(d)); }
    counters.synth = 0;
    const r = await produce("E-rec", inputs, out, { targetMinutes: 1, labels });
    const s3 = counters.synth; counters.synth = 0;
    await produce("E-rec", inputs, out, { targetMinutes: 1, labels }); // «refresh»: 0 llamadas
    console.log(JSON.stringify({ firstErr, synthBeforeTimeout: s1, secondErr, synthOnBlockedRetry: s2, paidCachedBefore: dataBefore, synthAfterReconcile: s3, synthOnRefresh: counters.synth, mp4: r.mp4 }));
  } else throw new Error("escenario B|C|D|E");
}
main().catch(e => { console.error(e); process.exit(1); });
