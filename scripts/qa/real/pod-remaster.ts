/**
 * Episodio COMPLETO en el estudio nuevo con material YA PAGADO (USD 0): el máster de audio (voces + música) y los 13
 * clips de HeyGen del episodio real b9c6784d, recompuestos con el código de claude/podcast-estudios:
 *  - personas recortadas de su fondo (matte.py, local) y sentadas en el estudio Moderno: plano general y primeros planos;
 *  - subtítulos con el TEXTO DEL GUION sincronizado por palabra (alineado con faster-whisper sobre el máster, local);
 *  - las 17 imágenes originales (Pexels) pasan por la verificación visual (CLIP, local): las pertinentes se conservan
 *    (sin la franja de subtítulos antiguos) y las ajenas se sustituyen por la tarjeta explícita de la idea del turno.
 * No escribe en producción: solo lee el episodio y sus archivos. Todo lo generado va a $EVID (cifrado).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID!, WORK = process.env.RUNNER_TEMP || "/tmp";
const ID = "b9c6784d-d443-431e-b84b-f2eba52f50b5";
const out = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const probe = (f: string, entries: string) => spawnSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", f], { encoding: "utf8" }).stdout;
const dur = (f: string) => Number(JSON.parse(probe(f, "format=duration")).format.duration);
fs.mkdirSync(path.join(EVID, "remaster"), { recursive: true });

async function main() {
  const { renderShot, muxEpisode, shotFrames } = await import("../../../src/lib/podcast/v3/compose");
  const { realMatter, localDirector, RVM_MODEL } = await import("../../../src/lib/podcast/v3/adapters");
  const dl = async (bucket: string, p: string) => { const { data } = await db.storage.from(bucket).download(p); if (!data) throw new Error(`descarga ${bucket}`); return Buffer.from(await data.arrayBuffer()); };
  const dir = path.join(WORK, "remaster"); fs.mkdirSync(dir, { recursive: true });
  const model = path.join(WORK, "rvm.onnx");
  fs.writeFileSync(model, Buffer.from(await (await fetch(RVM_MODEL.url)).arrayBuffer()));
  if (crypto.createHash("sha256").update(fs.readFileSync(model)).digest("hex") !== RVM_MODEL.sha256) throw new Error("huella del modelo");
  const matte = realMatter({ model });

  const { data: ep } = await db.from("podcast_studio_episodes").select("user_id,spec,result,audio_path").eq("id", ID).single();
  const spec = ep!.spec as { title: string; topic: string; script: string; participants: { id: "A" | "B"; avatar: { avatar_id: string } }[] };
  type S = { kind: string; start: number; end: number; speaker: "A" | "B" | null };
  const shots = (ep!.result as { shots: S[] }).shots;
  const master = path.join(dir, "master.mp3"); fs.writeFileSync(master, await dl("videos", ep!.audio_path));
  const total = dur(master);
  const orig = path.join(dir, "original.mp4"); fs.writeFileSync(orig, await dl("videos", `${ep!.user_id}/podcast-studio/${ID}/episodio.mp4`));

  // 1) Subtítulos: texto del guion alineado con el audio real.
  const wav = path.join(dir, "master.wav"); spawnSync("ffmpeg", ["-y", "-v", "error", "-i", master, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", wav]);
  const scriptFile = path.join(dir, "guion.txt"); fs.writeFileSync(scriptFile, spec.script);
  const al = spawnSync("python3", ["scripts/qa/real/pod-align.py", wav, scriptFile, path.join(dir, "palabras.json")], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (al.status !== 0) throw new Error(`alineación: ${al.stderr.slice(-300)}`);
  out("ALIGN", JSON.parse(al.stdout.trim().split("\n").pop()!));
  const words = JSON.parse(fs.readFileSync(path.join(dir, "palabras.json"), "utf8")) as { text: string; start: number; end: number }[];
  const wordsIn = (s: S) => words.filter((w) => w.start >= s.start - 0.05 && w.start < s.end).map((w) => ({ text: w.text, start: Math.max(0, w.start - s.start), end: Math.max(0, w.end - s.start) }));

  // 2) Clips pagados en el orden de los planos de avatar; la forma del clip confirma quién habla.
  const { data: ops } = await db.from("podcast_studio_operations").select("result,created_at").eq("episode_id", ID).eq("op", "avatar_clip").eq("state", "settled").order("created_at");
  const avatarShots = shots.map((s, i) => ({ s, i })).filter(({ s }) => ["two_shot", "avatar_a", "avatar_b", "over_shoulder"].includes(s.kind));
  if (avatarShots.length !== ops!.length) throw new Error(`planos de avatar ${avatarShots.length} ≠ clips ${ops!.length}`);
  const clipFor = new Map<number, string>();
  let mismatched = 0;
  for (const [k, { s, i }] of avatarShots.entries()) {
    const f = path.join(dir, `clip${k}.mp4`); fs.writeFileSync(f, await dl("videos", String(ops![k].result).replace(/^storage:/, "")));
    const st = JSON.parse(probe(f, "stream=width,height")).streams[0];
    const who = st.height > 1000 ? "A" : "B"; // Hans 720×1280, Valeria 720×784
    if (who !== s.speaker) mismatched++;
    clipFor.set(i, f);
  }
  out("CLIPS", { n: ops!.length, speakerMismatches: mismatched });
  if (mismatched) throw new Error("los clips no corresponden a los planos (no se recompone con lip-sync dudoso)");

  // 3) Recortes: clips (quien habla) y fotos fijas (quien escucha en el plano general).
  const { data: avs } = await db.from("avatars").select("id,source_photo_path").in("id", spec.participants.map((p) => p.avatar.avatar_id));
  const still = async (who: "A" | "B") => { const a = avs!.find((x) => x.id === spec.participants.find((p) => p.id === who)!.avatar.avatar_id)!; const f = path.join(dir, `still-${who}${path.extname(a.source_photo_path)}`); fs.writeFileSync(f, await dl("avatar-uploads", a.source_photo_path)); return matte(f, path.join(dir, `m-still-${who}`), true); };
  const stills = { A: await still("A"), B: await still("B") };
  const t0 = Date.now();
  const mattes = new Map<number, Awaited<ReturnType<typeof matte>>>();
  for (const [i, f] of clipFor) mattes.set(i, await matte(f, path.join(dir, `m-${i}`), false));
  out("MATTES", { clips: mattes.size, seconds: Math.round((Date.now() - t0) / 1000) });

  // 4) Imágenes originales: fotograma central SIN la franja de subtítulos antiguos → verificación visual.
  const imageShots = shots.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "imagen");
  const items = imageShots.map(({ s, i }) => {
    const f = path.join(dir, `img-${i}.jpg`);
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String((s.start + s.end) / 2), "-i", orig, "-frames:v", "1", "-vf", "crop=iw:ih*0.78:0:0", f]);
    return { image: f, brief: { turn_id: String(i), prompt: "", subject: `${spec.topic}: Anunnaki, sumerios, tablillas cuneiformes`, recreation: false } };
  });
  const v = await localDirector({ dir }).verify(items, spec.topic);
  const imageOf = new Map<number, { image: string | null; card: string | null }>();
  imageShots.forEach(({ s, i }, k) => {
    const idea = wordsIn(s).map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
    imageOf.set(i, v.verdicts[k].ok ? { image: items[k].image, card: null } : { image: null, card: idea.length > 90 ? `${idea.slice(0, 90).replace(/\s\S*$/, "")}…` : idea || spec.title });
    fs.copyFileSync(items[k].image, path.join(EVID, "remaster", `imagen-${String(i).padStart(2, "0")}-${v.verdicts[k].ok ? "ok" : "rechazada"}.jpg`));
  });
  out("IMAGES", { total: imageShots.length, kept: v.verdicts.filter((x) => x.ok).length, cards: v.verdicts.filter((x) => !x.ok).length });

  // 5) Montaje en el estudio Moderno (1920×1080) con el máster pagado.
  const frames = shotFrames(shots, total);
  const clips: string[] = [];
  const t1 = Date.now();
  for (const [i, s] of shots.entries()) {
    const kind = s.kind === "over_shoulder" ? (s.speaker === "A" ? "avatar_a" : "avatar_b") : s.kind;
    const shot = { turn_id: `S${i}`, speaker: s.speaker ?? undefined, kind, start: s.start, end: s.end, reason: "" } as never;
    const src = kind === "titulo" ? { title: spec.title }
      : kind === "imagen" ? { ...imageOf.get(i)!, words: wordsIn(s) }
      : { speakerMatte: mattes.get(i)!, listenerMatte: stills[s.speaker === "A" ? "B" : "A"], words: wordsIn(s) };
    clips.push(await renderShot(dir, i, shot, frames[i], src as never, { set: "moderno", frame: { w: 1920, h: 1080 }, swap: false, small: false, fade: true }));
  }
  const mp4 = await muxEpisode(dir, clips, master, path.join(dir, "episodio-estudio.mp4"), false);
  out("RENDER", { seconds: Math.round((Date.now() - t1) / 1000) });

  // 6) Comprobaciones del archivo final y copia de revisión (720p) + audio + hojas de contacto.
  const st = JSON.parse(probe(mp4, "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration"));
  const vs = st.streams.find((x: { codec_type: string }) => x.codec_type === "video"), as = st.streams.find((x: { codec_type: string }) => x.codec_type === "audio");
  const decode = spawnSync("ffmpeg", ["-v", "error", "-i", mp4, "-f", "null", "-"], { encoding: "utf8" });
  const mp3 = path.join(EVID, "remaster", "audio.mp3"); spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", mp3]);
  out("FINAL", { seconds: Number(st.format.duration), master: total, drift: Math.round((Number(st.format.duration) - total) * 1000) / 1000, video: `${vs?.codec_name} ${vs?.width}x${vs?.height} ${vs?.r_frame_rate}`, audio: as?.codec_name,
    decodeErrors: decode.stderr.trim().split("\n").filter(Boolean).length, bytes: fs.statSync(mp4).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(mp4)).digest("hex").slice(0, 16), mp3Seconds: dur(mp3) });
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", path.join(EVID, "remaster", "episodio-720p.mp4")]);
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", "fps=1/6,scale=480:-2,tile=8x8", "-frames:v", "1", path.join(EVID, "remaster", "hoja.jpg")]);
  out("EVID", fs.readdirSync(path.join(EVID, "remaster")).length);
}
main().catch((e) => { console.log("FAILED", e instanceof Error ? e.message.slice(0, 400) : String(e)); process.exitCode = 1; });
