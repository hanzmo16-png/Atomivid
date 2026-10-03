/**
 * ATOMIVID PRECAMPAIGN V2 CINEMATIC — master assembly. NO paid provider can be called here: the
 * workflow job gets no ElevenLabs/HeyGen keys. Paid assets are only REPLAYED from the ledger:
 *   - TTS lines + HeyGen avatar of V1 (project precampaign-teaser-v1, COMMITTED rows → stored results);
 *   - VFX-001 output (project atomivid-vfx-001, COMMITTED row → stored result, kind vfx_transform).
 * If any of them is missing or fails its sha256 check, the stage stops (never regenerates).
 *
 * Creative: real Hans (new takes, pro voice chain, approved warm look) → ONE hero VFX moment
 * (apartment → New York at night, progressive) → premium transitions → avatar → demo / results cut on
 * the words, music aligned to the beat grid → reveal → real closing + CTA → animated end card.
 * Subtle local sound design (whoosh / riser / hit, synthesized with ffmpeg). Output 1080x1920 30 fps.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HLG_TO_SDR, RETOUCH_GRAPH } from "./v2-look";

export {};

const sh = promisify(execFile);
const FF = process.env.FFMPEG_BIN ?? "ffmpeg";
const FP = process.env.FFPROBE_BIN ?? "ffprobe";
const W = 1080, H = 1920, FPS = 30;
const OUT = resolve("teaser-v2/output");
const WORK = resolve("teaser-v2/work");
const FONT = resolve("public/fonts/Anton-Regular.ttf");
const V1_PROJECT = "precampaign-teaser-v1";
const VFX_PROJECT = "atomivid-vfx-001";
const OPENING_TEXT = "Llevo meses trabajando en algo que por fin hoy te puedo empezar a enseñar.";
const CLOSING_TEXT = "Estamos terminando las últimas pruebas. Si quieres ser de los primeros en probarlo, escribe ATOMIVID en los comentarios.";
const LINES = {
  avatar: "Se llama ATOMIVID. Tú le das una idea… y empieza la producción.",
  demo: "Guion. Voz. Imágenes. Movimiento. Música. Subtítulos. Todo dentro del mismo proceso.",
  results: "Y esto no es una presentación. Son videos que ya estamos produciendo.",
  reveal: "De hecho… el video que estás viendo también fue creado con ATOMIVID.",
} as const;
type LineKey = keyof typeof LINES;
/** Professional voice chain for the real takes (decided from the v2-analyze audio report). */
/**
 * From the v2-analyze report of the new external mic: hot input (−11.5/−9.8 LUFS, peaks at 0 dBFS, a few
 * full-scale samples), very clean (37/47 dB speech-to-noise), dry (−30 dB decay in 0.22–0.36 s, no
 * de-reverb needed), dark balance (2–6 kHz ≈ 12 dB under 150–500 Hz). So: pre-gain, rumble cut, light
 * denoise, low-mid cleanup, presence and air, gentle de-ess, moderate compression, peak limiter.
 */
const VOICE_CHAIN_DEFAULT =
  "volume=-6dB,highpass=f=75,afftdn=nr=6:nf=-55:tn=1,equalizer=f=220:t=q:w=1.0:g=-2,equalizer=f=3200:t=q:w=1.1:g=3,highshelf=f=9000:g=1.5," +
  "deesser=i=0.2,acompressor=threshold=0.1:ratio=2.5:attack=10:release=160:makeup=1.4,alimiter=limit=0.89:level=disabled";
const VOICE_LUFS = -16;

type Word = { text: string; start: number; end: number; limit?: number };
type Args = { openingPath: string; closingPath: string; vfxStart: number; openingStart?: number; closingTrim?: [number, number]; voiceChain?: string; musicPath?: string; tonemap?: "hable" | "mobius" | "clip" | "none"; useVfx?: boolean; vfxCompositePath?: string; outputPath?: string };

const run = (bin: string, args: string[]) => sh(bin, args, { maxBuffer: 256 * 1024 * 1024 });
const ff = (args: string[]) => run(FF, ["-hide_banner", "-v", "error", "-y", ...args]);
const ffLog = async (args: string[]) => (await run(FF, ["-hide_banner", "-nostats", ...args]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }))).stderr;
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

async function probe(file: string) {
  const { stdout } = await run(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; side_data_list?: { rotation?: number }[] }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const rot = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0));
  const swap = rot === 90 || rot === 270;
  const [n, d] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return { width: (swap ? v?.height : v?.width) ?? 0, height: (swap ? v?.width : v?.height) ?? 0, fps: d ? n / d : 0, duration: Number(j.format?.duration ?? 0), vDur: Number(v?.duration ?? 0), aDur: Number(a?.duration ?? 0), hasAudio: Boolean(a) };
}
async function lufs(file: string) {
  const s = (await ffLog(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"])).split("Summary:").at(-1) ?? "";
  return { i: Number(/I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1]), tp: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(s)?.[1]), lra: Number(/LRA:\s+(-?[\d.]+) LU/.exec(s)?.[1]) };
}
/** Speech window by silencedetect (start of first speech, end of last speech). */
async function speechWindow(file: string, duration: number) {
  const log = await ffLog(["-i", file, "-af", "silencedetect=noise=-38dB:d=0.25", "-f", "null", "-"]);
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  let a = 0, b = duration;
  if (starts.length && starts[0] < 0.05 && ends.length) a = ends[0];
  const last = starts.at(-1);
  if (last !== undefined && (ends.length < starts.length || (ends.at(-1) ?? 0) >= duration - 0.05)) b = last;
  return { start: a, end: b };
}
/** Display words of the known line, timed on the local transcription (same count → 1:1, else proportional). */
function alignWords(text: string, heard: Word[], fallback: [number, number]): Word[] {
  const words = text.split(/\s+/);
  if (heard.length === words.length) return words.map((w, i) => ({ text: w, start: heard[i].start, end: heard[i].end }));
  const [a, b] = heard.length ? [heard[0].start, heard.at(-1)!.end] : fallback;
  const weights = words.map((w) => w.length + 1), total = weights.reduce((x, y) => x + y, 0);
  let t = a;
  return words.map((w, i) => { const d = ((b - a) * weights[i]) / total; const r = { text: w, start: t, end: t + d }; t += d; return r; });
}

async function main() {
  const args = JSON.parse(process.env.TEASER_V2_ARGS || "{}") as Args;
  if (!args.openingPath || !args.closingPath || !Number.isFinite(args.vfxStart)) throw new Error("Faltan openingPath/closingPath/vfxStart en TEASER_V2_ARGS.");
  await mkdir(OUT, { recursive: true });
  await mkdir(WORK, { recursive: true });
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const { supabaseResultStore } = await import("../../src/lib/paid-calls/result-store");
  const { loadVfx } = await import("../../src/lib/paid-calls/gated-vfx");
  const service = createServiceClient();
  const videos = service.storage.from("videos");
  const results = supabaseResultStore(service, "videos");
  const get = async (bucket: string, path: string, to: string) => {
    const { data, error } = await service.storage.from(bucket).download(path);
    if (error || !data) throw new Error(`No se pudo leer ${bucket}/${path}`);
    const b = Buffer.from(await data.arrayBuffer());
    await writeFile(to, b);
    return b;
  };
  const notes: string[] = [];

  // ---------- Replay paid assets from the ledger (never call a provider) ----------
  const { data: rows } = await service.from("pi_paid_operations").select("project_id,provider,shot_id,status,committed_usd,result_ref").in("project_id", [V1_PROJECT, VFX_PROJECT]);
  const ledger = rows ?? [];
  const committed = ledger.filter((r) => r.status === "COMMITTED" && r.result_ref);
  const tts = {} as Record<LineKey, { file: string; duration: number; words: Word[] }>;
  for (const r of committed.filter((x) => x.project_id === V1_PROJECT && x.provider === "elevenlabs")) {
    const meta = await results.getJson<{ audioPath: string; sha256: string; words: { text: string; startSeconds: number; endSeconds: number }[]; extension: string }>(r.result_ref!);
    const bytes = meta ? await results.getBytes(meta.audioPath) : null;
    if (!meta || !bytes || sha256(bytes) !== meta.sha256) continue;
    const heard = meta.words.map((w) => w.text).join(" ");
    const h = new Set(norm(heard));
    const score = (k: LineKey) => norm(LINES[k]).filter((w) => h.has(w)).length / norm(LINES[k]).length;
    const key = (Object.keys(LINES) as LineKey[]).reduce((a, b) => (score(b) > score(a) ? b : a));
    if (score(key) < 0.85 || (tts[key] && tts[key].words.length)) continue;
    const file = join(WORK, `tts-${key}.${meta.extension}`);
    await writeFile(file, bytes);
    tts[key] = { file, duration: (await probe(file)).duration, words: meta.words.map((w) => ({ text: w.text, start: w.startSeconds, end: w.endSeconds })) };
  }
  const missing = (Object.keys(LINES) as LineKey[]).filter((k) => !tts[k]);
  if (missing.length) throw new Error(`TTS persistido no disponible para ${missing.join(", ")}: STOP (no se vuelve a pagar ElevenLabs).`);
  const avatarRow = committed.find((r) => r.project_id === V1_PROJECT && r.provider === "heygen");
  const avatarMeta = avatarRow ? await results.getJson<{ videoPath: string; sha256: string }>(avatarRow.result_ref!) : null;
  const avatarBytes = avatarMeta ? await results.getBytes(avatarMeta.videoPath) : null;
  if (!avatarMeta || !avatarBytes || sha256(avatarBytes) !== avatarMeta.sha256) throw new Error("Avatar HeyGen persistido no disponible: STOP (no se vuelve a pagar HeyGen).");
  const avatarFile = join(WORK, "avatar.mp4");
  await writeFile(avatarFile, avatarBytes);
  const vfxRow = committed.find((r) => r.project_id === VFX_PROJECT && r.provider === "luma");
  // A paid VFX result is only used when its identity QA approved it (useVfx !== false).
  // VFX-002 (subject-locked local composite) replaces the full-frame VFX-001 output: Hans' pixels come
  // from the real take; the composite starts as the untouched source, so it is layered without a fade.
  const compFile = args.vfxCompositePath ? join(WORK, "vfx-002-composite.mp4") : null;
  const compBytes = compFile ? await get("videos", args.vfxCompositePath!, compFile) : null;
  const vfxAsset = !compFile && vfxRow && args.useVfx !== false ? await loadVfx(results, vfxRow.result_ref!) : null;
  const vfxFile = join(WORK, "vfx-001-output.mp4");
  if (vfxAsset) await writeFile(vfxFile, vfxAsset.buffer);
  else if (compFile) notes.push("VFX-002: composite local con píxeles del sujeto bloqueados (VFX-001 de Luma solo como material de fondo).");
  else notes.push(vfxRow ? "VFX-001 generado pero vetado en QA de identidad: apertura real sin VFX." : "VFX-001 no disponible: apertura real sin VFX.");
  const hasVfx = Boolean(vfxAsset || compFile);

  // ---------- Inputs ----------
  const opening = join(WORK, "opening.mp4"), closing = join(WORK, "closing.mp4"), dulce = join(WORK, "dulce.mp4"), ocean = join(WORK, "ocean.mp4"), music = join(WORK, "music.mp3");
  await get("videos", args.openingPath, opening);
  await get("videos", args.closingPath, closing);
  const manifest = JSON.parse(Buffer.from(await (await videos.download("dulce-001/full-v1/final/manifest.json")).data!.arrayBuffer()).toString()) as { parts: string[] };
  const parts: Buffer[] = [];
  for (const p of manifest.parts) parts.push(Buffer.from(await (await videos.download(p)).data!.arrayBuffer()));
  await writeFile(dulce, Buffer.concat(parts));
  await get("videos", "ocean-deep-001/samples/episode/sample-approval-motion-production-check.mp4", ocean);
  await get("music-library", args.musicPath ?? "elevenlabs-corporate-2.mp3", music);

  // ---------- Real takes: trim, approved look, pro voice chain, loudness match, local transcription ----------
  const voiceChain = args.voiceChain ?? VOICE_CHAIN_DEFAULT;
  const TM = !args.tonemap || args.tonemap === "none" ? "null" : HLG_TO_SDR(args.tonemap);
  const seg = (n: string) => join(WORK, `seg-${n}.mp4`);
  const enc = ["-r", String(FPS), "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"];
  const segExt = (n: string) => seg(n).replace(/\.mp4$/, ".mov");
  const transcribe = async (file: string, a: number, b: number, name: string) => {
    const wav = join(WORK, `${name}-16k.wav`);
    await ff(["-ss", a.toFixed(3), "-to", b.toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const out = join(WORK, `${name}-words.json`);
    await run("python3", [resolve("scripts/precampaign-teaser/transcribe.py"), wav, out, "small"]);
    return (JSON.parse(await readFile(out, "utf8")) as { words: Word[] }).words;
  };
  const voiceGain = async (file: string, chainOnly: string) => {
    const tmp = join(WORK, `gain-${Math.random().toString(36).slice(2)}.wav`);
    await ff(["-i", file, "-vn", "-af", chainOnly, "-ar", "48000", tmp]);
    const m = await lufs(tmp);
    return Number.isFinite(m.i) ? VOICE_LUFS - m.i : 0;
  };

  const op = await probe(opening), cp = await probe(closing);
  // Speech windows from the local transcription (footsteps/movement before speaking are not silence).
  const heardO = await transcribe(opening, 0, op.duration, "opening-full");
  const heardC = await transcribe(closing, 0, cp.duration, "closing-full");
  const sw = (h: Word[], f: { start: number; end: number }) => (h.length ? { start: h[0].start, end: h.at(-1)!.end } : f);
  const ow = sw(heardO, await speechWindow(opening, op.duration)), cw = sw(heardC, await speechWindow(closing, cp.duration));
  const vfxEnd = args.vfxStart + 5;
  const XF0 = 0.35;
  const oA = Math.max(0, args.openingStart ?? ow.start - 0.25);
  const oB = hasVfx ? vfxEnd : Math.min(op.duration, ow.end + 0.45);
  if (hasVfx && ow.end > vfxEnd - XF0 + 0.02) notes.push(`La voz de apertura termina en ${ow.end.toFixed(2)} s, cerca del fin del VFX (${vfxEnd.toFixed(2)} s).`);
  const [cA, cB] = args.closingTrim ?? [Math.max(0, cw.start - 0.25), Math.min(cp.duration, cw.end + 0.45)];
  const gO = await voiceGain(opening, voiceChain), gC = await voiceGain(closing, voiceChain);
  // Opening: base real take (look) + VFX layered in progressively from the window start.
  {
    const off = Math.max(0, args.vfxStart - oA);
    const graph = compFile
      ? `[0:v]${TM},scale=${W}:${H}:flags=lanczos,fps=${FPS},setsar=1[src];${RETOUCH_GRAPH("src", "base")};` +
        `[1:v]scale=${W}:${H}:flags=lanczos,fps=${FPS},setsar=1,format=yuv420p,setpts=PTS-STARTPTS+${off.toFixed(3)}/TB[fx];` +
        `[base][fx]overlay=eof_action=pass:format=auto,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.3[v]`
      : vfxAsset
      ? `[0:v]${TM},scale=${W}:${H}:flags=lanczos,fps=${FPS},setsar=1[src];${RETOUCH_GRAPH("src", "base")};` +
        `[1:v]scale=${W}:${H}:flags=lanczos,unsharp=5:5:0.45:5:5:0,noise=alls=3:allf=t,fps=${FPS},setsar=1,format=yuva420p,fade=t=in:st=0:d=1.6:alpha=1,setpts=PTS-STARTPTS+${off.toFixed(3)}/TB[fx];` +
        `[base][fx]overlay=eof_action=pass:format=auto,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.3[v]`
      : `[0:v]${TM},scale=${W}:${H}:flags=lanczos,fps=${FPS},setsar=1[src];${RETOUCH_GRAPH("src", "v0")};[v0]tpad=stop_mode=clone:stop_duration=0.3[v]`;
    await ff(["-ss", oA.toFixed(3), "-to", oB.toFixed(3), "-i", opening, ...(compFile ? ["-i", compFile] : vfxAsset ? ["-i", vfxFile] : []), "-filter_complex", `${graph};[0:a]${voiceChain},volume=${gO.toFixed(2)}dB,aresample=48000,apad=whole_dur=${(oB - oA).toFixed(3)}[a]`, "-map", "[v]", "-map", "[a]", "-t", (oB - oA).toFixed(3), ...enc, segExt("opening")]);
  }
  await ff(["-ss", cA.toFixed(3), "-to", cB.toFixed(3), "-i", closing, "-filter_complex", `[0:v]${TM},scale=${W}:${H}:flags=lanczos,fps=${FPS},setsar=1[src];${RETOUCH_GRAPH("src", "v0")};[v0]tpad=stop_mode=clone:stop_duration=0.3[v];[0:a]${voiceChain},volume=${gC.toFixed(2)}dB,aresample=48000,apad=whole_dur=${(cB - cA).toFixed(3)}[a]`, "-map", "[v]", "-map", "[a]", "-t", (cB - cA).toFixed(3), ...enc, segExt("closing")]);
  const rel = (h: Word[], a: number, b: number) => h.filter((w) => w.start >= a - 0.05 && w.end <= b + 0.05).map((w) => ({ ...w, start: w.start - a, end: w.end - a }));
  const openingWords = alignWords(OPENING_TEXT, rel(heardO, oA, oB), [ow.start - oA, ow.end - oA]);
  const closingWords = alignWords(CLOSING_TEXT, rel(heardC, cA, cB), [cw.start - cA, cw.end - cA]);

  // ---------- TTS loudness match (same target as the real voice) ----------
  const ttsGain: Record<string, number> = {};
  for (const k of Object.keys(LINES) as LineKey[]) { const m = await lufs(tts[k].file); ttsGain[k] = Number.isFinite(m.i) ? VOICE_LUFS - m.i : 0; }

  // ---------- Avatar (frozen last frame up to the exact audio length) ----------
  await ff(["-i", avatarFile, "-i", tts.avatar.file, "-filter_complex", `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,tpad=stop_mode=clone:stop_duration=2[v];[1:a]volume=${ttsGain.avatar.toFixed(2)}dB,aresample=48000[a]`, "-map", "[v]", "-map", "[a]", "-t", tts.avatar.duration.toFixed(3), ...enc, segExt("avatar")]);

  // ---------- Montages: cuts on the words, micro push-in, animated typography ----------
  const dulceDur = (await probe(dulce)).duration, oceanDur = (await probe(ocean)).duration;
  const SAFE = "crop=iw*0.80:ih*0.64:iw*0.10:ih*0.14";
  const D = (sec: number) => ({ file: dulce, at: Math.min(sec, dulceDur - 3) });
  const O = (sec: number) => ({ file: ocean, at: Math.min(sec, oceanDur - 3) });
  const esc = (t: string) => t.replace(/:/g, "\\:").replace(/'/g, "\u2019");
  /** Fade + 24 px rise in 0.22 s, fade out 0.15 s before `to`. */
  const label = (text: string, from: number, to: number, y: number, size: number) =>
    `drawtext=fontfile=${FONT}:text='${esc(text)}':fontcolor=white:fontsize=${size}:x=(w-tw)/2:y=${y}+24*(1-min(1\\,max(0\\,(t-${from.toFixed(2)})/0.22))):borderw=5:bordercolor=black@0.8:` +
    `alpha='if(lt(t\\,${from.toFixed(2)})\\,0\\,if(lt(t\\,${(from + 0.22).toFixed(2)})\\,(t-${from.toFixed(2)})/0.22\\,if(gt(t\\,${(to - 0.15).toFixed(2)})\\,max(0\\,(${to.toFixed(2)}-t)/0.15)\\,1)))'`;
  const wordStart = (k: LineKey, re: RegExp) => tts[k].words.find((w) => re.test(norm(w.text).join(" ")))?.start;
  const montage = async (name: LineKey, picks: { file: string; at: number }[], cuts: number[], extra: string) => {
    const dur = tts[name].duration + 0.3;
    const bounds = [0, ...cuts.slice(1), dur];
    const args2: string[] = [];
    picks.forEach((p, i) => args2.push("-ss", p.at.toFixed(2), "-t", (bounds[i + 1] - bounds[i] + 0.1).toFixed(3), "-i", p.file));
    args2.push("-i", tts[name].file);
    const chains = picks.map((_, i) => {
      const len = bounds[i + 1] - bounds[i], frames = Math.max(2, Math.round(len * FPS));
      return `[${i}:v]${SAFE},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.13:saturation=0.8,setsar=1[bg${i}];` +
        `[${i}:v]${SAFE},scale=${W}:-2,setsar=1,fps=${FPS},zoompan=z='1+0.045*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${Math.round((W * 0.64 * 9) / (16 * 0.8) / 2) * 2}:fps=${FPS}[fg${i}];` +
        `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2-140:shortest=1,fps=${FPS},trim=duration=${len.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`;
    });
    const filter = `${chains.join(";")};${picks.map((_, i) => `[v${i}]`).join("")}concat=n=${picks.length}:v=1:a=0[mv];[mv]${extra || "null"}[vout];[${picks.length}:a]volume=${ttsGain[name].toFixed(2)}dB,apad=whole_dur=${dur.toFixed(3)},aresample=48000[aout]`;
    await ff([...args2, "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]", "-t", dur.toFixed(3), ...enc, segExt(name)]);
  };
  // Demo: one shot per pipeline word, the label lands with the word.
  const demoWords = ["guion", "voz", "imagenes", "movimiento", "musica", "subtitulos", "todo"].map((w) => wordStart("demo", new RegExp(`^${w}`)) ?? NaN);
  const demoCuts = demoWords.map((t, i) => (Number.isFinite(t) ? t : (i * tts.demo.duration) / 7));
  demoCuts[0] = 0;
  const demoLabels = ["GUION", "VOZ", "IMÁGENES", "MOVIMIENTO", "MÚSICA", "SUBTÍTULOS"];
  await montage("demo", [D(14.5), O(2.2), D(185), O(6.0), O(22.3), D(199), D(242)], demoCuts,
    demoLabels.map((t, i) => label(t, Math.max(0.02, (demoWords[i] ?? demoCuts[i]) - 0.05), demoCuts[i + 1], 330, 108)).join(","));
  // Results: cuts on the beats of the sentence.
  const r1 = wordStart("results", /^presentacion/) ?? 1.6, r2 = wordStart("results", /^son$/) ?? 2.4, r3 = wordStart("results", /^ya$/) ?? 3.2;
  await montage("results", [D(170), D(455.8), O(11.7), D(242.5), O(20.1)], [0, r1, r2, r3, Math.min(tts.results.duration, r3 + 0.9)], label("HECHO CON ATOMIVID", 0.05, tts.results.duration + 0.3, 300, 70));
  // Reveal: "CREATED WITH ATOMIVID" lands on "creado".
  const created = wordStart("reveal", /^creado/) ?? 2.6;
  const elVideo = wordStart("reveal", /^el$/) ?? 1.2;
  await montage("reveal", [O(36), D(195)], [0, elVideo], label("CREATED WITH ATOMIVID", created, tts.reveal.duration + 0.3, 330, 92));
  // End card ≤ 1.2 s: wordmark rises in, claim and "Próximamente." follow.
  const END = 1.2;
  await ff(["-f", "lavfi", "-i", `color=c=0x0d1220:s=${W}x${H}:d=${END}:r=${FPS}`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex",
    `[0:v]vignette=angle=PI/5,drawbox=x=(iw-220)/2:y=760:w=220:h=8:color=0x7fd3ff:t=fill:enable='gte(t\\,0.12)',${label("ATOMIVID", 0.0, 9, 800, 170)},${label("Tu idea. Tu video.", 0.18, 9, 1030, 72)},` +
    `drawtext=fontfile=${FONT}:text='Próximamente.':fontcolor=0x7fd3ff:fontsize=58:x=(w-tw)/2:y=1140:alpha='min(1\\,max(0\\,(t-0.36)/0.2))'[v]`,
    "-map", "[v]", "-map", "1:a", "-t", String(END), ...enc, segExt("end")]);

  // ---------- Assembly with per-boundary transitions ----------
  const order = ["opening", "avatar", "demo", "results", "reveal", "closing", "end"] as const;
  const trans: { type: string; d: number }[] = [
    { type: "zoomin", d: XF0 }, // hero VFX → avatar
    { type: "fade", d: 0.04 }, // cut on the beat
    { type: "fade", d: 0.04 },
    { type: "dissolve", d: 0.3 }, // into the reveal (riser)
    { type: "dissolve", d: 0.4 }, // reveal → real Hans (soft, no white frame)
    { type: "fade", d: 0.35 }, // → end card
  ];
  const durs: Record<string, number> = {};
  const avDrift: Record<string, number> = {};
  for (const n of order) {
    const p = await probe(segExt(n));
    durs[n] = p.duration;
    avDrift[n] = Math.round(Math.abs(p.vDur - p.aDur) * 1000);
  }
  if (Math.max(...Object.values(avDrift)) > 60) throw new Error(`Desfase A/V por segmento (ms): ${JSON.stringify(avDrift)}`);
  const offsets: Record<string, number> = { opening: 0 };
  for (let i = 1; i < order.length; i++) offsets[order[i]] = offsets[order[i - 1]] + durs[order[i - 1]] - trans[i - 1].d;
  let vchain = "", achain = "", prevV = "0:v", prevA = "0:a";
  for (let i = 1; i < order.length; i++) {
    const t = trans[i - 1];
    vchain += `[${prevV}][${i}:v]xfade=transition=${t.type}:duration=${t.d}:offset=${offsets[order[i]].toFixed(3)}[v${i}];`;
    achain += `[${prevA}][${i}:a]acrossfade=d=${t.d}:c1=tri:c2=tri[a${i}];`;
    prevV = `v${i}`;
    prevA = `a${i}`;
  }
  const assembled = join(WORK, "assembled.mov");
  await ff([...order.flatMap((n) => ["-i", segExt(n)]), "-filter_complex", `${vchain}${achain.slice(0, -1)}`, "-map", `[${prevV}]`, "-map", `[${prevA}]`, ...enc, assembled]);
  const total = (await probe(assembled)).duration;

  // ---------- Captions: word highlight, ATOMIVID accent, never crossing into the next section ----------
  const place = (k: string, ws: Word[]) => ws.map((w) => ({ ...w, start: w.start + offsets[k], end: w.end + offsets[k], limit: offsets[k] + durs[k] - (trans[order.indexOf(k as never)]?.d ?? 0) }));
  const timeline: Word[] = [...place("opening", openingWords), ...(["avatar", "demo", "results", "reveal"] as const).flatMap((k) => place(k, tts[k].words)), ...place("closing", closingWords)];
  const ts = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, "0"); return `${h}:${String(m).padStart(2, "0")}:${x}`; };
  const chunks: Word[][] = [];
  for (const w of timeline) {
    const cur = chunks.at(-1);
    if (!cur || cur.length >= 3 || cur.at(-1)!.limit !== w.limit || /[.,…?!]$/.test(cur.at(-1)!.text) || w.start - cur.at(-1)!.end > 0.4) chunks.push([w]);
    else cur.push(w);
  }
  const events: string[] = [];
  chunks.forEach((c, ci) => {
    const next = chunks[ci + 1]?.[0].start ?? Infinity;
    const end = Math.min(c.at(-1)!.end + 0.08, next, c.at(-1)!.limit ?? Infinity);
    c.forEach((w, i) => {
      const to = i === c.length - 1 ? end : Math.min(c[i + 1].start, end);
      if (to - w.start < 0.02) return;
      const text = c.map((x, j) => `{\\c${j === i ? "&H0000D7FF&" : /ATOMIVID/i.test(x.text) ? "&H00FFD37F&" : "&H00FFFFFF&"}}${x.text.toUpperCase()}`).join(" ");
      events.push(`Dialogue: 0,${ts(w.start)},${ts(to)},Cap,,0,0,0,,${text}`);
    });
  });
  const assPath = join(WORK, "captions.ass");
  await writeFile(assPath, ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cap,Anton,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,6,2,2,140,160,560,1", "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, ""].join("\n"));

  // ---------- Music on the beat grid + subtle sound design + ducking + loudness ----------
  const music22 = join(WORK, "music-22k.wav");
  await ff(["-i", music, "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", music22]);
  const beatsJson = join(WORK, "beats.json");
  await run("python3", [resolve("scripts/precampaign-teaser/beats.py"), music22, beatsJson]);
  const beats = JSON.parse(await readFile(beatsJson, "utf8")) as { bpm: number; period: number; phase: number; beats: number[] };
  const cutTimes = order.slice(1).map((n, i) => offsets[n] + trans[i].d / 2);
  // Music start offset (within one beat) that puts the most cuts on a beat.
  let bestOff = 0, bestScore = Infinity;
  for (let m = 0; m < beats.period; m += 0.01) {
    const score = cutTimes.reduce((s, t) => { const x = ((t + m - beats.phase) % beats.period + beats.period) % beats.period; return s + Math.min(x, beats.period - x); }, 0);
    if (score < bestScore) { bestScore = score; bestOff = m; }
  }
  const sfx = join(WORK, "sfx.wav");
  const whoosh = (at: number, vol: number) => `anoisesrc=d=0.7:c=pink:a=0.6:r=48000,highpass=f=280,lowpass=f=5200,afade=t=in:d=0.42:curve=exp,afade=t=out:st=0.42:d=0.26,volume=${vol},adelay=${Math.max(0, Math.round((at - 0.42) * 1000))}|${Math.max(0, Math.round((at - 0.42) * 1000))}`;
  const riser = (end: number) => `aevalsrc='0.25*sin(2*PI*(160+420*t*t/1.2)*t)':s=48000:d=1.2,afade=t=in:d=1.0:curve=exp,afade=t=out:st=1.12:d=0.08,volume=0.35,aformat=channel_layouts=stereo,adelay=${Math.round((end - 1.2) * 1000)}|${Math.round((end - 1.2) * 1000)}`;
  const hit = (at: number, vol: number) => `aevalsrc='(0.9*sin(2*PI*52*t)+0.25*sin(2*PI*104*t))*exp(-4.5*t)':s=48000:d=1.2,volume=${vol},aformat=channel_layouts=stereo,adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}`;
  const sfxParts = [whoosh(cutTimes[0], 0.22), whoosh(cutTimes[1], 0.12), riser(cutTimes[3]), hit(cutTimes[4], 0.3), whoosh(cutTimes[4], 0.1), hit(cutTimes[5], 0.45)];
  await ff([...sfxParts.flatMap((p) => ["-f", "lavfi", "-i", p]), "-filter_complex", `${sfxParts.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[s${i}]`).join(";")};${sfxParts.map((_, i) => `[s${i}]`).join("")}amix=inputs=${sfxParts.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[o]`, "-map", "[o]", "-ar", "48000", sfx]);

  const master = join(OUT, "ATOMIVID-precampaign-v2-cinematic.mp4");
  await ff(["-i", assembled, "-ss", bestOff.toFixed(3), "-stream_loop", "-1", "-i", music, "-i", sfx, "-filter_complex",
    `[0:v]subtitles=${assPath}:fontsdir=${resolve("public/fonts")}[v];` +
    `[1:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.3,afade=t=in:d=0.5,afade=t=out:st=${(total - 1.3).toFixed(3)}:d=1.3[m];` +
    `[0:a]asplit=2[vo][sc];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=280[md];` +
    `[vo][md][2:a]amix=inputs=3:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
    "-map", "[v]", "-map", "[a]", "-t", total.toFixed(3), "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", master]);

  // ---------- QA ----------
  const m = await probe(master);
  const blk = await ffLog(["-i", master, "-vf", "blackdetect=d=0.25:pix_th=0.08", "-an", "-f", "null", "-"]);
  const blackIntervals = [...blk.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
  const loud = await lufs(master);
  const first = await ffLog(["-i", master, "-vf", "select=eq(n\\,0),signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
  const firstYavg = Number(/YAVG=([\d.]+)/.exec(first)?.[1]);
  const lum = await ffLog(["-i", master, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"]);
  const whiteFrames = [...lum.matchAll(/YAVG=([\d.]+)/g)].filter((x) => Number(x[1]) > 235).length;
  const evTimes = events.map((e) => e.split(",").slice(1, 3).map((x) => { const [h, mm, s] = x.split(":"); return Number(h) * 3600 + Number(mm) * 60 + Number(s); }));
  const overlaps = evTimes.filter((t, i) => i > 0 && t[0] < evTimes[i - 1][1] - 0.011).length;
  const crossings = order.slice(1).filter((n) => evTimes.some(([a, b]) => a < offsets[n] - 0.02 && b > offsets[n] + 0.05)).length;
  await ff(["-i", master, "-vf", "fps=1/1.25,scale=180:-2,tile=7x4", "-frames:v", "1", join(OUT, "contact-sheet.jpg")]);
  for (const n of order) await ff(["-ss", (offsets[n] + Math.min(1.2, durs[n] / 2)).toFixed(2), "-i", master, "-frames:v", "1", "-vf", "scale=540:-2", join(OUT, `frame-${n}.jpg`)]);
  await ff(["-i", master, "-vf", "scale=540:960", "-c:v", "libx264", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(OUT, "preview-540p.mp4")]);
  // V1 vs V2 side by side.
  const v1 = join(WORK, "v1.mp4");
  const v1ok = await get("videos", "precampaign-teaser-v1/output/ATOMIVID-precampaign-teaser-v1.mp4", v1).then(() => true).catch(() => false);
  if (v1ok) {
    const L = Math.max(total, (await probe(v1)).duration);
    await ff(["-i", v1, "-i", master, "-filter_complex",
      `[0:v]scale=540:960,setsar=1,tpad=stop_mode=clone:stop_duration=${L.toFixed(2)},drawtext=fontfile=${FONT}:text='V1':fontcolor=white:fontsize=44:x=24:y=24:borderw=3[a];` +
      `[1:v]scale=540:960,setsar=1,tpad=stop_mode=clone:stop_duration=${L.toFixed(2)},drawtext=fontfile=${FONT}:text='V2 CINEMATIC':fontcolor=0x7fd3ff:fontsize=44:x=24:y=24:borderw=3[b];[a][b]hstack=2[v];[1:a]apad[au]`,
      "-map", "[v]", "-map", "[au]", "-t", L.toFixed(2), "-c:v", "libx264", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(OUT, "compare-v1-vs-v2.mp4")]);
  }
  // Source vs VFX.
  if (vfxAsset) {
    const { data: list } = await videos.list("precampaign-teaser-v1/v2", { limit: 100 });
    const src = (list ?? []).find((e) => e.name.startsWith("vfx-001-source-"));
    if (src) {
      const sf = join(WORK, "vfx-source.mp4");
      await get("videos", `precampaign-teaser-v1/v2/${src.name}`, sf);
      await ff(["-i", sf, "-i", vfxFile, "-filter_complex", `[0:v]scale=540:960,setsar=1,fps=30,drawtext=fontfile=${FONT}:text='SOURCE':fontcolor=white:fontsize=40:x=20:y=20:borderw=3[a];[1:v]scale=540:960,setsar=1,fps=30,drawtext=fontfile=${FONT}:text='VFX-001':fontcolor=0x7fd3ff:fontsize=40:x=20:y=20:borderw=3[b];[a][b]hstack=2`, "-t", "5", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", join(OUT, "vfx-source-vs-output.mp4")]);
    }
  }
  const costRows = ledger.map((r) => ({ project: r.project_id, provider: r.provider, shot: r.shot_id, status: r.status, committedUsd: Number(r.committed_usd ?? 0) }));
  const sum = (p: string) => Math.round(costRows.filter((r) => r.project === p).reduce((a, r) => a + r.committedUsd, 0) * 10000) / 10000;
  const costReport = { v1CommittedUsd: sum(V1_PROJECT), vfxCommittedUsd: sum(VFX_PROJECT), incrementalV2Usd: sum(VFX_PROJECT), masterStagePaidCalls: 0, rows: costRows };
  const qa = {
    resolution: `${m.width}x${m.height}`, fps: Math.round(m.fps * 1000) / 1000, durationSeconds: Math.round(m.duration * 100) / 100,
    checks: {
      resolution1080x1920: m.width === W && m.height === H, fps30: Math.abs(m.fps - FPS) < 0.05, duration30to36: m.duration >= 30 && m.duration <= 36,
      audioPresent: m.hasAudio, firstFrameVisual: firstYavg > 16, noAccidentalBlack: blackIntervals.length === 0, noClipping: loud.tp <= -1.0,
      loudnessAround14: Math.abs(loud.i + 14) <= 1, noFullWhiteFrames: whiteFrames === 0, captionsNoOverlap: overlaps === 0, captionsWithinSections: crossings === 0, endCardMax1_5s: END <= 1.5,
      avSyncPerSegmentMs60: Math.max(...Object.values(avDrift)) <= 60, vfxIntegrated: hasVfx,
    },
    loudnessLufs: loud.i, truePeakDbfs: loud.tp, loudnessRangeLu: loud.lra, firstFrameYavg: firstYavg, blackIntervals, avSyncDriftMsPerSegment: avDrift,
    music: { bpm: beats.bpm, startOffsetSeconds: bestOff, cutTimes, meanCutBeatErrorSeconds: Math.round((bestScore / cutTimes.length) * 1000) / 1000 },
    voice: { chain: voiceChain, targetLufs: VOICE_LUFS, gainsDb: { opening: gO, closing: gC, ...ttsGain } },
    trims: { opening: [oA, oB], closing: [cA, cB], vfxWindow: [args.vfxStart, vfxEnd] },
    vfx: compFile ? { kind: "VFX-002 subject-locked local composite", path: args.vfxCompositePath, sha256: sha256(compBytes!) } : vfxAsset ? { kind: "VFX-001 full-frame" } : null,
    sections: Object.fromEntries(order.map((n) => [n, { start: Math.round(offsets[n] * 100) / 100, duration: Math.round(durs[n] * 100) / 100 }])),
    transitions: trans, notes,
  };
  await writeFile(join(OUT, "qa-report.json"), JSON.stringify(qa, null, 2) + "\n");
  await writeFile(join(OUT, "cost-report.json"), JSON.stringify(costReport, null, 2) + "\n");
  await writeFile(join(OUT, "captions.ass"), await readFile(assPath));
  const outputPath = args.outputPath ?? "precampaign-teaser-v1/output/ATOMIVID-precampaign-v2-cinematic.mp4";
  await videos.upload(outputPath, await readFile(master), { contentType: "video/mp4", upsert: true });
  console.log(JSON.stringify({ qa, costReport: { ...costReport, rows: undefined } }, null, 2));
}

main().catch((err) => {
  console.error("Master V2 detenido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
