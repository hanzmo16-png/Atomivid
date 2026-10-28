// Publica el catálogo de anfitriones del podcast en el almacenamiento PRIVADO (USD 0, sin proveedores de pago):
// por anfitrión, foto (para HeyGen y la foto fija de quien escucha) y recorte con alfa (vista previa del estudio), con
// el mismo recorte que el worker (matte.py, RobustVideoMatting). Valeria: su foto registrada (avatar-uploads del dueño) y
// una muestra de voz de su episodio real b9c6784d (tramo ya pagado). Ximena y Víctor: retratos generados (candidates/).
// Imprime solo tamaños y caras detectadas; las imágenes van a $EVID (cifrado) para revisión.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID, WORK = process.env.RUNNER_TEMP || "/tmp";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (t, v) => console.log(t, JSON.stringify(v));
fs.mkdirSync(EVID, { recursive: true });
const RVM = { url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx", sha256: "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828" };
const model = path.join(WORK, "rvm.onnx");
fs.writeFileSync(model, Buffer.from(await (await fetch(RVM.url)).arrayBuffer()));
if (crypto.createHash("sha256").update(fs.readFileSync(model)).digest("hex") !== RVM.sha256) { out("STOP", "modelo de recorte con otra huella"); process.exit(1); }
const dl = async (bucket, p) => { const { data } = await db.storage.from(bucket).download(p); return data ? Buffer.from(await data.arrayBuffer()) : null; };
const up = async (p, buf, type) => { const { error } = await db.storage.from("videos").upload(p, buf, { contentType: type, upsert: true }); return !error; };
// Foto de Valeria: la de su avatar registrado (fila avatars, asset dcf70e13) en avatar-uploads del dueño.
const { data: val } = await db.from("avatars").select("source_photo_path,provider_avatar_id").eq("provider_avatar_id", "asset:dcf70e13d7b44cd2ad95836412120ab4").eq("status", "ready").limit(1).maybeSingle();
const sources = { valeria: val?.source_photo_path ? await dl("avatar-uploads", val.source_photo_path) : null, ximena: await dl("videos", "podcast-catalog/candidates/anfitriona-4.webp"), victor: await dl("videos", "podcast-catalog/candidates/anfitrion-4.webp") };
for (const [id, buf] of Object.entries(sources)) {
  if (!buf) { out("HOST", { id, ok: false, error: "foto de origen no encontrada" }); continue; }
  const src = path.join(WORK, `${id}-src`); fs.writeFileSync(src, buf);
  const jpg = path.join(WORK, `${id}.jpg`);
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-q:v", "2", jpg]);
  const fg = path.join(WORK, `${id}-fg.png`), a = path.join(WORK, `${id}-a.png`), rgba = path.join(WORK, `${id}-recorte.png`);
  const r = spawnSync("python3", ["scripts/podcast-3-0/matte.py", model, jpg, fg, a, "--still", "12", "--extend", "0.3"], { encoding: "utf8" });
  const m = JSON.parse((r.stdout || "{}").trim().split("\n").pop() || "{}");
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", fg, "-i", a, "-filter_complex", "[0][1]alphamerge", "-frames:v", "1", rgba]);
  const ok1 = await up(`podcast-catalog/hosts/${id}/foto.jpg`, fs.readFileSync(jpg), "image/jpeg");
  const ok2 = fs.existsSync(rgba) && await up(`podcast-catalog/hosts/${id}/recorte.png`, fs.readFileSync(rgba), "image/png");
  for (const f of [jpg, rgba]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(EVID, path.basename(f)));
  out("HOST", { id, ok: ok1 && ok2, w: m.w, h: m.h, face: m.face });
}
// Muestra de voz de Valeria: su primera intervención a cámara en el episodio real (41,3–47,2 s), sin pagar nada nuevo.
const { data: ep } = await db.from("podcast_studio_episodes").select("audio_path").eq("id", "b9c6784d-d443-431e-b84b-f2eba52f50b5").single();
const mp3 = ep?.audio_path ? await dl("videos", ep.audio_path) : null;
if (mp3) {
  const f = path.join(WORK, "ep.mp3"), s = path.join(WORK, "muestra.mp3"); fs.writeFileSync(f, mp3);
  spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "41.3", "-t", "5.9", "-i", f, "-af", "afade=t=in:d=0.15,afade=t=out:st=5.6:d=0.3", "-c:a", "libmp3lame", "-b:a", "128k", s]);
  out("SAMPLE", { ok: await up("podcast-catalog/hosts/valeria/muestra.mp3", fs.readFileSync(s), "audio/mpeg") });
  fs.copyFileSync(s, path.join(EVID, "valeria-muestra.mp3"));
} else out("SAMPLE", { ok: false });
