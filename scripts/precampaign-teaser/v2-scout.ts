/**
 * ATOMIVID PRECAMPAIGN V2 — free scouting for the VFX-002 correction (USD 0, no paid provider).
 *
 * 1. NYC night MOTION plates: Pexels Videos search (free API, stock license) for Times Square /
 *    Manhattan night clips. For each candidate: best hi-res file, a small proxy download, camera-motion
 *    estimate (global phase-correlation shift: a locked-off tripod shot is required behind a fixed
 *    camera) and local-motion energy (traffic/screens), plus a 3-frame strip. Nothing is stored in
 *    Storage; the artifact is for human/agent selection.
 * 2. Real ATOMIVID interface: Playwright screenshots of the deployed production app (public pages
 *    only, no login, no account).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export {};

const sh = promisify(execFile);
const OUT = resolve("teaser-v2/scout");
const KEY = process.env.PEXELS_API_KEY ?? "";
const APP = process.env.SCOUT_APP_URL ?? "https://atomivid.vercel.app";
const run = (bin: string, args: string[]) => sh(bin, args, { maxBuffer: 256 * 1024 * 1024 });

type PexelsFile = { link: string; width: number | null; height: number | null; quality: string | null; file_type: string; fps?: number | null };
type PexelsVideo = { id: number; url: string; duration: number; width: number; height: number; user?: { name?: string }; video_files: PexelsFile[] };

const QUERIES = (process.env.SCOUT_QUERIES ?? "times square night|times square traffic night|new york night traffic|manhattan night street|new york yellow taxi night|nyc night street static|times square timelapse|new york city night lights")
  .split("|");

function best(files: PexelsFile[]) {
  const mp4 = files.filter((f) => f.file_type === "video/mp4" && f.width && f.height);
  const big = [...mp4].sort((a, b) => b.width! * b.height! - a.width! * a.height!)[0];
  const proxy = [...mp4].filter((f) => Math.min(f.width!, f.height!) >= 360).sort((a, b) => a.width! * a.height! - b.width! * b.height!)[0];
  return { big, proxy };
}

/** SCOUT_PLATES=id,id,…: hi-res export of chosen candidates for local framing (landscape → centered
 * 2160x2160 square scaled to 1920x1920; portrait → 1080x1920), 8 s from t=1 s, 30 fps, no audio. */
async function plates(ids: string[]) {
  await mkdir(join(OUT, "plates"), { recursive: true });
  const meta: unknown[] = [];
  for (const id of ids) {
    const res = await fetch(`https://api.pexels.com/videos/videos/${id}`, { headers: { Authorization: KEY } });
    if (!res.ok) { console.warn(`Pexels ${res.status} para ${id}`); continue; }
    const v = (await res.json()) as PexelsVideo;
    const { big } = best(v.video_files);
    const raw = join(OUT, "plates", `${id}-raw.mp4`);
    await writeFile(raw, Buffer.from(await (await fetch(big.link)).arrayBuffer()));
    const portrait = big.height! > big.width!;
    const vf = portrait ? "scale=1080:1920:flags=lanczos" : "crop=ih:ih,scale=1920:1920:flags=lanczos";
    await run("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-t", "8", "-i", raw, "-vf", `${vf},fps=30,format=yuv420p`, "-an", "-c:v", "libx264", "-crf", "17", "-preset", "medium", join(OUT, "plates", `${id}.mp4`)]);
    meta.push({ id: v.id, page: v.url, author: v.user?.name ?? null, source: { width: big.width, height: big.height, fps: big.fps ?? null }, export: portrait ? "1080x1920" : "1920x1920 (center square of full height)" });
  }
  await writeFile(join(OUT, "plates.json"), JSON.stringify(meta, null, 2) + "\n");
}

async function main() {
  if (process.env.SCOUT_PLATES) {
    if (!KEY) throw new Error("Falta PEXELS_API_KEY.");
    return plates(process.env.SCOUT_PLATES.split(",").map((x) => x.trim()).filter(Boolean));
  }
  await mkdir(join(OUT, "nyc"), { recursive: true });
  const seen = new Map<number, PexelsVideo & { query: string }>();
  if (!KEY) throw new Error("Falta PEXELS_API_KEY.");
  for (const q of QUERIES) {
    for (const orientation of ["landscape", "portrait"]) {
      const p = new URLSearchParams({ query: q, orientation, per_page: "15", size: "large" });
      const res = await fetch(`https://api.pexels.com/videos/search?${p}`, { headers: { Authorization: KEY } });
      if (!res.ok) { console.warn(`Pexels ${res.status} para "${q}"`); continue; }
      const data = (await res.json()) as { videos: PexelsVideo[] };
      for (const v of data.videos) if (!seen.has(v.id) && v.duration >= 6) seen.set(v.id, { ...v, query: q });
    }
  }
  const results: unknown[] = [];
  for (const v of seen.values()) {
    const { big, proxy } = best(v.video_files);
    if (!big || !proxy) continue;
    // Vertical 1080x1920 is needed: portrait >= 1080 wide, or landscape >= 2160 tall (crop 9:16 from 4K).
    const usable = big.height! >= big.width! ? big.width! >= 1080 : big.height! >= 2160;
    const local = join(OUT, "nyc", `${v.id}.mp4`);
    try {
      const r = await fetch(proxy.link);
      if (!r.ok) continue;
      await writeFile(local, Buffer.from(await r.arrayBuffer()));
      const { stdout } = await run("python3", [resolve("scripts/precampaign-teaser/scout_motion.py"), local, join(OUT, "nyc", `${v.id}.jpg`)]);
      const m = JSON.parse(stdout.trim().split("\n").at(-1)!);
      results.push({ id: v.id, query: v.query, page: v.url, author: v.user?.name ?? null, duration: v.duration, hiRes: { link: big.link, width: big.width, height: big.height, fps: big.fps ?? null }, usableFor1080x1920: usable, ...m });
    } catch (e) {
      console.warn(`candidato ${v.id} omitido:`, e instanceof Error ? e.message : e);
    }
  }
  results.sort((a, b) => (a as { cameraShiftPxPerSec: number }).cameraShiftPxPerSec - (b as { cameraShiftPxPerSec: number }).cameraShiftPxPerSec);
  await writeFile(join(OUT, "nyc-candidates.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`candidatos: ${results.length}`);

  // Real interface: public production pages (no login).
  const { stdout } = await run("node", [resolve("scripts/precampaign-teaser/scout_ui.mjs"), APP, join(OUT, "ui")]).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: `UI capture failed: ${e.stderr ?? ""}` }));
  console.log(stdout);
}

main().catch((err) => {
  console.error("Scout detenido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
