/**
 * Prueba corta del nuevo estudio con material REAL ya pagado (antes de gastar en un episodio largo):
 *  - fragmento 3,0–47,26 s del episodio b9c6784d (Hans y Valeria): plano general de los dos (clip 1, Hans habla),
 *    la imagen del turno → UNA ilustración real de Recraft con su guion visual y su verificación (Anthropic), y el
 *    primer plano de Valeria (clip 2); audio del máster ya pagado. Recorte de las personas en el runner (sin coste).
 *  - vistas previas de los tres estudios con los anfitriones del catálogo (plano general y primeros planos, 16:9 y 9:16).
 * Gasto máximo: 1 imagen + 1 regeneración (Recraft, ~USD 0,08) y 2–3 llamadas de Anthropic (~USD 0,05). Todo lo
 * generado va a $EVID (cifrado). Se ejecuta con el código de la rama claude/podcast-estudios (src/ y scripts/podcast-3-0/).
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
fs.mkdirSync(path.join(EVID, "fragmento"), { recursive: true });
fs.mkdirSync(path.join(EVID, "estudios"), { recursive: true });

async function main() {
  const { renderShot, muxEpisode, shotFrames, FPS } = await import("../../../src/lib/podcast/v3/compose");
  const { realMatter, localDirector, realRecraftImages, RVM_MODEL } = await import("../../../src/lib/podcast/v3/adapters");
  const { NEGATIVE_IMAGE } = await import("../../../src/lib/podcast/v3/pipeline");
  const { HOST_CATALOG } = await import("../../../src/lib/podcast/v3/catalog");
  const { STUDIO_IDS } = await import("../../../src/lib/podcast/v3/studios");
  const dl = async (bucket: string, p: string) => { const { data } = await db.storage.from(bucket).download(p); return data ? Buffer.from(await data.arrayBuffer()) : null; };
  const model = path.join(WORK, "rvm.onnx");
  fs.writeFileSync(model, Buffer.from(await (await fetch(RVM_MODEL.url)).arrayBuffer()));
  if (crypto.createHash("sha256").update(fs.readFileSync(model)).digest("hex") !== RVM_MODEL.sha256) throw new Error("huella del modelo");
  const matte = realMatter({ model });
  const dir = path.join(WORK, "frag"); fs.mkdirSync(dir, { recursive: true });

  // Material ya pagado del episodio real.
  const { data: ep } = await db.from("podcast_studio_episodes").select("user_id,spec,result,audio_path").eq("id", ID).single();
  const { data: ops } = await db.from("podcast_studio_operations").select("result,created_at").eq("episode_id", ID).eq("op", "avatar_clip").eq("state", "settled").order("created_at");
  const clip = async (n: number) => { const p = String(ops![n].result).replace(/^storage:/, ""); const f = path.join(dir, `clip${n}.mp4`); fs.writeFileSync(f, (await dl("videos", p))!); return f; };
  const master = path.join(dir, "master.mp3"); fs.writeFileSync(master, (await dl("videos", ep!.audio_path))!);
  const spec = ep!.spec as { title: string; topic: string; script: string; participants: { id: "A" | "B"; avatar: { avatar_id: string } }[] };
  const { data: avs } = await db.from("avatars").select("id,source_photo_path").in("id", spec.participants.map((p) => p.avatar.avatar_id));
  const stillOf = async (who: "A" | "B") => { const a = avs!.find((x) => x.id === spec.participants.find((p) => p.id === who)!.avatar.avatar_id)!; const f = path.join(dir, `still-${who}${path.extname(a.source_photo_path)}`); fs.writeFileSync(f, (await dl("avatar-uploads", a.source_photo_path))!); return f; };

  const t0 = Date.now();
  const hans = await matte(await clip(0), path.join(dir, "m-hans"), false);
  const val = await matte(await clip(1), path.join(dir, "m-val"), false);
  const valStill = await matte(await stillOf("B"), path.join(dir, "m-val-still"), true);
  out("MATTE", { seconds: Math.round((Date.now() - t0) / 1000), clipSeconds: 26.04, hansFace: hans.face, valFace: val.face });

  // Ilustración real del turno 1 (Hans): guion visual → Recraft → verificación (lote).
  const t1 = spec.script.split("\n").find((l) => /\S/.test(l))!.replace(/^[^:]{1,60}:\s*/, "");
  const director = localDirector({ dir });
  // Controles negativos: fotogramas del episodio ORIGINAL con fotos ajenas (avión, huevos de Pascua, plantas, ropa).
  // La verificación visual debe rechazarlos todos para este tema.
  const epMp4 = path.join(dir, "original.mp4"); fs.writeFileSync(epMp4, (await dl("videos", `${ep!.user_id}/podcast-studio/${ID}/episodio.mp4`))!);
  const controls = [[128, "avion"], [62, "huevos"], [300, "plantas"], [376, "ropa"]] as const;
  const ctl: { image: string; brief: { turn_id: string; prompt: string; subject: string; recreation: boolean } }[] = [];
  for (const [t, n] of controls) { const f = path.join(dir, `control-${n}.jpg`); spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", epMp4, "-frames:v", "1", f]); fs.copyFileSync(f, path.join(EVID, "fragmento", `control-${n}.jpg`)); ctl.push({ image: f, brief: { turn_id: n, prompt: "", subject: `${spec.topic}: Anunnaki, sumerios, tablillas cuneiformes`, recreation: false } }); }
  const cv = await director.verify(ctl, spec.topic);
  out("NEGATIVE_CONTROLS", controls.map(([, n], i) => ({ n, ok: cv.verdicts[i].ok, reason: cv.verdicts[i].reason })));
  const brief = await director.brief({ topic: spec.topic, title: spec.title, language: "es", turns: [{ id: "T001", text: t1 }] });
  const b = brief.briefs[0];
  out("BRIEF", { usd: brief.actualUsd, subject: b?.subject, recreation: b?.recreation, prompt: b?.prompt?.slice(0, 160) });
  const styleRefs = async () => {
    const urls: string[] = [];
    for (const f of fs.readdirSync("public/podcast/estilo").filter((x) => /\.jpe?g$/.test(x))) {
      const p = `podcast-catalog/estilo/${f}`;
      await db.storage.from("videos").upload(p, fs.readFileSync(path.join("public/podcast/estilo", f)), { contentType: "image/jpeg", upsert: true });
      const { data } = await db.storage.from("videos").createSignedUrl(p, 3600); if (data?.signedUrl) urls.push(data.signedUrl);
    }
    return urls;
  };
  const rc = realRecraftImages({ styleRefs });
  let img: string | null = null, verdicts: { ok: boolean; reason: string }[] = [], spent = brief.actualUsd;
  // Reutiliza la ilustración ya pagada (ejecución 40729682472: zigurat con tablillas, sin personas) si está en el
  // repositorio: se vuelve a verificar, pero no se genera otra (USD 0).
  const reuse = "scripts/qa/real/fixtures/ilustracion-zigurat.png";
  if (fs.existsSync(reuse)) {
    const f = path.join(dir, "ilustracion-reutilizada.png"); fs.copyFileSync(reuse, f);
    const v = await director.verify([{ image: f, brief: b }], spec.topic);
    out("IMAGE", { attempt: 0, reused: true, ok: v.verdicts[0].ok, reason: v.verdicts[0].reason, usd: v.actualUsd });
    if (v.verdicts[0].ok) img = f; verdicts = v.verdicts;
  }
  for (let attempt = 1; attempt <= 2 && !img; attempt++) {
    const f = path.join(dir, `ilustracion-${attempt}.png`);
    const prompt = attempt === 1 ? b.prompt : `${b.prompt}. The image must clearly show: ${b.subject}. Do not include: ${verdicts[0]?.reason}.`;
    const g = await rc.generate!({ prompt, negative: NEGATIVE_IMAGE, aspect: "16:9", attempt }, f);
    const v = await director.verify([{ image: f, brief: b }], spec.topic);
    spent += g.actualUsd + v.actualUsd; verdicts = v.verdicts;
    fs.copyFileSync(f, path.join(EVID, "fragmento", `ilustracion-${attempt}.png`));
    out("IMAGE", { attempt, ok: v.verdicts[0].ok, reason: v.verdicts[0].reason, usd: g.actualUsd + v.actualUsd });
    if (v.verdicts[0].ok) img = f;
  }

  // Fragmento: 3,0–47,26 s del episodio (plano general A · imagen · primer plano B), estudio Moderno, 1920×1080.
  const shots = [
    { turn_id: "T001", speaker: "A" as const, kind: "two_shot" as const, start: 3, end: 23, reason: "" },
    { turn_id: "T001", speaker: "A" as const, kind: "imagen" as const, start: 23, end: 41.244979, reason: "", asset_id: "rc", ...(b?.recreation ? { label: "Recreación" as const } : {}) },
    { turn_id: "T002", speaker: "B" as const, kind: "avatar_b" as const, start: 41.244979, end: 47.260646, reason: "" },
  ].map((s) => ({ ...s, start: s.start - 3, end: s.end - 3 }));
  const frames = shotFrames(shots, 44.260646);
  const sub = t1.slice(0, 160);
  const clips: string[] = [];
  for (const [i, s] of shots.entries()) {
    const src = s.kind === "two_shot" ? { speakerMatte: hans, listenerMatte: valStill, subtitle: sub } : s.kind === "avatar_b" ? { speakerMatte: val, subtitle: "Gracias a ti. Es un tema que me apasiona y que mucha gente entiende a medias." } : { image: img, card: img ? null : b.subject, subtitle: sub };
    clips.push(await renderShot(dir, i, s, frames[i], src, { set: "moderno", frame: { w: 1920, h: 1080 }, swap: false, small: false, fade: true }));
  }
  const audio = path.join(dir, "seg.wav");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "3", "-t", "44.260646", "-i", master, audio]);
  const mp4 = await muxEpisode(dir, clips, audio, path.join(EVID, "fragmento", "fragmento.mp4"), false);
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", "fps=1/3,scale=640:-2,tile=5x3", "-frames:v", "1", path.join(EVID, "fragmento", "hoja.jpg")]);
  out("FRAGMENT", { seconds: Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" }).stdout.trim()), bytes: fs.statSync(mp4).size, usd: Math.round(spent * 1e4) / 1e4, fps: FPS });

  // Vistas previas: anfitriones del catálogo en los tres estudios (plano general + primeros planos), 16:9 y 9:16.
  const cat = async (id: string) => { const h = HOST_CATALOG.find((x) => x.id === id)!; const f = path.join(dir, `cat-${id}.jpg`); fs.writeFileSync(f, (await dl("videos", h.photo))!); return matte(f, path.join(dir, `m-cat-${id}`), true); };
  const pairs: [string, string][] = [["valeria", "victor"], ["ximena", "victor"], ["valeria", "ximena"]];
  const mattes: Record<string, Awaited<ReturnType<typeof cat>>> = {};
  for (const id of ["valeria", "ximena", "victor"]) mattes[id] = await cat(id);
  let k = 100;
  for (const [i, st] of STUDIO_IDS.entries()) {
    const [a, bb] = pairs[i];
    for (const [kind, fr] of [["two_shot", { w: 1920, h: 1080 }], ["avatar_a", { w: 1920, h: 1080 }], ["avatar_b", { w: 1920, h: 1080 }], ["two_shot", { w: 1080, h: 1920 }], ["avatar_b", { w: 1080, h: 1920 }]] as const) {
      const speaker = kind === "avatar_b" ? "B" : "A";
      const f = await renderShot(dir, k++, { turn_id: "T", speaker, kind, start: 0, end: 1, reason: "" }, 2,
        { speakerMatte: mattes[speaker === "A" ? a : bb], listenerMatte: mattes[speaker === "A" ? bb : a], subtitle: "Bienvenidos a un nuevo episodio. Hoy hablamos de los Anunnaki y los sumerios." }, { set: st, frame: fr, swap: false, small: false, fade: false });
      spawnSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-frames:v", "1", path.join(EVID, "estudios", `${st}-${kind}-${fr.w}x${fr.h}.jpg`)]);
    }
  }
  out("PREVIEWS", { files: fs.readdirSync(path.join(EVID, "estudios")).length });
}
main().catch((e) => { console.log("FAILED", e instanceof Error ? e.message.slice(0, 400) : String(e)); process.exitCode = 1; });
