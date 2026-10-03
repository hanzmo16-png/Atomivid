/** V2 look test (free): HLG → SDR variants + approved polish on two frames of each take, for review. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HLG_TO_SDR, RETOUCH_GRAPH } from "./v2-look";

export {};
const sh = promisify(execFile);
const OUT = resolve("teaser-v2/analysis");

async function main() {
  const args = JSON.parse(process.env.TEASER_V2_ARGS || "{}") as { files: string[]; times: number[] };
  await mkdir(OUT, { recursive: true });
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const videos = createServiceClient().storage.from("videos");
  const variants: Record<string, string> = { raw: "null", hable: HLG_TO_SDR("hable"), mobius: HLG_TO_SDR("mobius"), clip: HLG_TO_SDR("clip") };
  for (const [fi, path] of args.files.entries()) {
    const { data } = await videos.download(path);
    if (!data) throw new Error(`No se pudo leer ${path}`);
    const local = join(OUT, `lt-${fi}.mp4`);
    await writeFile(local, Buffer.from(await data.arrayBuffer()));
    for (const t of args.times) {
      const inputs = Object.keys(variants).map((k, i) => `[s${i}]${variants[k]},scale=360:640,setsar=1[t${i}];${RETOUCH_GRAPH(`t${i}`, `r${i}`)};[r${i}]drawtext=text='${k}':fontcolor=white:fontsize=22:x=8:y=8:box=1:boxcolor=black@0.6[o${i}]`).join(";");
      const split = `[0:v]split=${Object.keys(variants).length}${Object.keys(variants).map((_, i) => `[s${i}]`).join("")}`;
      await promisify(execFile)("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(t), "-i", local, "-frames:v", "1", "-filter_complex", `${split};${inputs};${Object.keys(variants).map((_, i) => `[o${i}]`).join("")}hstack=${Object.keys(variants).length}`, join(OUT, `looktest-${fi}-${t}.jpg`)]);
    }
  }
  await sh("ls", [OUT]);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
