/**
 * Prueba de la verificación visual (USD 0): toma un fotograma cada 4 s del episodio ORIGINAL b9c6784d (con las fotos de
 * Pexels ajenas al tema) y pasa TODOS por la verificación local (CLIP) con el tema del episodio. Imprime el veredicto por
 * segundo y deja hojas de contacto rotuladas (segundo, OK/NO) en $EVID para comparar con una revisión visual humana.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID!, WORK = process.env.RUNNER_TEMP || "/tmp";
const ID = "b9c6784d-d443-431e-b84b-f2eba52f50b5";
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const { localDirector } = await import("../../../src/lib/podcast/v3/adapters");
  const dir = path.join(WORK, "scan"); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(EVID, "scan"), { recursive: true });
  const { data: ep } = await db.from("podcast_studio_episodes").select("user_id,spec").eq("id", ID).single();
  const spec = ep!.spec as { topic: string };
  const { data } = await db.storage.from("videos").download(`${ep!.user_id}/podcast-studio/${ID}/episodio.mp4`);
  const mp4 = path.join(dir, "original.mp4"); fs.writeFileSync(mp4, Buffer.from(await data!.arrayBuffer()));
  spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", "fps=1/4,scale=480:-2", path.join(dir, "f%03d.jpg")]);
  const frames = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
  const items = frames.map((f, i) => ({ image: path.join(dir, f), brief: { turn_id: String(i * 4 + 2), prompt: "", subject: `${spec.topic}: Anunnaki, sumerios, tablillas cuneiformes`, recreation: false } }));
  const v = await localDirector({ dir }).verify(items, spec.topic);
  const rows = items.map((it, i) => ({ s: Number(it.brief.turn_id), ok: v.verdicts[i].ok, reason: v.verdicts[i].reason }));
  for (const r of rows) console.log("SCAN", JSON.stringify(r));
  // Hojas de contacto de 4×4 en orden (fila a fila, 4 s por celda; hoja N empieza en el segundo (N-1)·64+2), marco
  // verde = aceptada, rojo = rechazada (sin texto: el ffmpeg del runner no trae fuentes).
  rows.forEach((r, i) => spawnSync("ffmpeg", ["-y", "-v", "error", "-i", items[i].image, "-vf",
    `scale=480:270,setsar=1,drawbox=x=0:y=0:w=480:h=270:color=${r.ok ? "lime" : "red"}:t=10`, path.join(dir, `l${String(i).padStart(3, "0")}.jpg`)]));
  for (let p = 0; p * 16 < rows.length; p++) {
    const files = rows.slice(p * 16, p * 16 + 16).map((_, k) => path.join(dir, `l${String(p * 16 + k).padStart(3, "0")}.jpg`));
    const args = files.flatMap((f) => ["-i", f]);
    const n = files.length, layout = files.map((_, k) => `${(k % 4) * 480}_${Math.floor(k / 4) * 270}`).join("|");
    const pre = files.map((_, k) => `[${k}]scale=480:270,setsar=1[v${k}]`).join(";");
    spawnSync("ffmpeg", ["-y", "-v", "error", ...args, "-filter_complex", `${pre};${files.map((_, k) => `[v${k}]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=black`, path.join(EVID, "scan", `hoja-${p + 1}.jpg`)]);
  }
  console.log("SCAN_SUMMARY", JSON.stringify({ frames: rows.length, rejected: rows.filter((r) => !r.ok).length }));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
