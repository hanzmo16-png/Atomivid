/** Calibración del verificador visual (USD 0): prepara las imágenes etiquetadas y ejecuta pod-calib.py. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
const WORK = process.env.RUNNER_TEMP || "/tmp", ID = "b9c6784d-d443-431e-b84b-f2eba52f50b5";
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
// Etiquetas de la revisión visual (índice del plano en el episodio original): pertinentes y ajenas.
const OK = [4, 8, 10, 15, 18, 19, 23, 24], AJENAS = [2, 5, 11, 12, 17, 21, 26, 29, 30];
async function main() {
  const dir = path.join(WORK, "calib"); fs.mkdirSync(dir, { recursive: true });
  const { data: ep } = await db.from("podcast_studio_episodes").select("user_id,spec,result").eq("id", ID).single();
  const spec = ep!.spec as { topic: string }; const shots = (ep!.result as { shots: { start: number; end: number }[] }).shots;
  const { data } = await db.storage.from("videos").download(`${ep!.user_id}/podcast-studio/${ID}/episodio.mp4`);
  const mp4 = path.join(dir, "o.mp4"); fs.writeFileSync(mp4, Buffer.from(await data!.arrayBuffer()));
  const expected = `${spec.topic}: Anunnaki, sumerios, tablillas cuneiformes`;
  const items: { image: string; label: string; expected: string; topic: string; name: string }[] = [];
  for (const i of [...OK, ...AJENAS]) for (const crop of [true, false]) {
    const f = path.join(dir, `i${i}-${crop ? "c" : "f"}.jpg`), s = shots[i];
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String((s.start + s.end) / 2), "-i", mp4, "-frames:v", "1", ...(crop ? ["-vf", "crop=iw:ih*0.78:0:0"] : []), f]);
    items.push({ image: f, label: OK.includes(i) ? "ok" : "ajena", expected, topic: spec.topic, name: `img-${i}${crop ? "-recorte" : ""}` });
  }
  items.push({ image: "scripts/qa/real/fixtures/ilustracion-zigurat.png", label: "ok", expected, topic: spec.topic, name: "recraft-zigurat" });
  fs.writeFileSync(path.join(dir, "items.json"), JSON.stringify(items));
  const r = spawnSync("python3", ["scripts/qa/real/pod-calib.py", path.join(dir, "items.json")], { encoding: "utf8", maxBuffer: 1 << 24, env: { ...process.env, CALIB_VARIANTS: "1" } });
  process.stdout.write(r.stdout); if (r.status !== 0) { console.log("FAILED", r.stderr.slice(-500)); process.exitCode = 1; }
}
main().catch((e) => { console.log("FAILED", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
