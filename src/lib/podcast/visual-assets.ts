/**
 * Podcast → video: licensed stock picture for every scene of the visual plan (server only: network + ffmpeg).
 *  - A Pexels video clip that matches the scene's words (searched most specific first, title as fallback), never the
 *    clip shown just before; slowed down to at most MIN_CLIP_SPEED when it is a little short.
 *  - Otherwise a Pexels photo animated with a slow zoom/pan (Ken Burns), so the picture always moves.
 *  - Each shot is normalised here to an exact-length 1920x1080/25 fps MP4 without audio (+ a small margin), so the
 *    editor only has to cut, subtitle and verify; a missing shot never blocks the episode (null → the montage uses
 *    a card for that scene only).
 * Pexels searches go through pexelsFetch (rate limit honoured, cached per query). No paid call is made here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FootageCandidateRaw } from "@/lib/ai/footage";
import { pickClip, sceneQueries, type Scene } from "./visual-plan";

/** Extra seconds rendered past each scene so frame rounding never leaves the editor short of picture. */
export const SHOT_MARGIN_SECONDS = 0.5;
const RECENT_WINDOW = 3;

export type SceneShot = {
  sceneIndex: number;
  file: string;
  seconds: number;
  size: number;
  sha256: string;
  kind: "video" | "photo";
  sourceId: string;
  credit: string;
  pageUrl?: string;
};

export type VisualDeps = {
  searchVideos: (query: string) => Promise<FootageCandidateRaw[]>;
  searchPhotos: (query: string) => Promise<FootageCandidateRaw[]>;
  download: (url: string, dest: string) => Promise<void>;
  /** Renders `src` into an exact-length normalised MP4 at `dest`. */
  renderClip: (src: string, dest: string, seconds: number, speed: number) => Promise<void>;
  renderPhoto: (src: string, dest: string, seconds: number, variant: number) => Promise<void>;
  onProgress?: (done: number, total: number) => unknown;
  log?: (tag: string, v: unknown) => void;
};

async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function buildSceneShots(scenes: Scene[], title: string, dir: string, deps: VisualDeps): Promise<(SceneShot | null)[]> {
  const videoCache = new Map<string, Promise<FootageCandidateRaw[]>>();
  const photoCache = new Map<string, Promise<FootageCandidateRaw[]>>();
  const cached = (cache: Map<string, Promise<FootageCandidateRaw[]>>, q: string, fn: (q: string) => Promise<FootageCandidateRaw[]>) => {
    if (!cache.has(q)) cache.set(q, fn(q).catch(() => []));
    return cache.get(q)!;
  };
  const used = new Set<string>();
  const recent: string[] = [];
  const shots: (SceneShot | null)[] = [];
  let videos = 0, photos = 0, missing = 0;
  for (const scene of scenes) {
    const seconds = Number((scene.end - scene.start + SHOT_MARGIN_SECONDS).toFixed(3));
    const dest = path.join(dir, `escena-${String(scene.index + 1).padStart(4, "0")}.mp4`);
    const queries = sceneQueries(scene, title);
    let shot: SceneShot | null = null;
    const finish = async (kind: SceneShot["kind"], c: FootageCandidateRaw) => {
      const { size } = await stat(dest);
      return { sceneIndex: scene.index, file: dest, seconds, size, sha256: await sha256File(dest), kind, sourceId: c.sourceId, credit: `${c.photographer?.trim() || "Pexels"} / Pexels`, pageUrl: c.pageUrl };
    };
    for (const q of queries) {
      if (shot) break;
      const candidates = await cached(videoCache, q, deps.searchVideos);
      const tried = new Set<string>();
      for (let attempt = 0; attempt < 2 && !shot; attempt++) {
        const pick = pickClip(candidates.filter((c) => !tried.has(c.sourceId)), seconds, recent, used);
        if (!pick) break;
        tried.add(pick.clip.sourceId);
        const raw = `${dest}.src`;
        try {
          await deps.download(pick.clip.url, raw);
          await deps.renderClip(raw, dest, seconds, pick.speed);
          shot = await finish("video", pick.clip);
        } catch {
          deps.log?.("SHOT_RETRY", { scene: scene.index, kind: "video" });
        } finally {
          await rm(raw, { force: true });
        }
      }
    }
    for (const q of queries) {
      if (shot) break;
      const candidates = (await cached(photoCache, q, deps.searchPhotos)).filter((c) => !recent.includes(c.sourceId));
      const photo = candidates.find((c) => !used.has(c.sourceId)) ?? candidates[0];
      if (!photo) continue;
      const raw = `${dest}.img`;
      try {
        await deps.download(photo.url, raw);
        await deps.renderPhoto(raw, dest, seconds, scene.index);
        shot = await finish("photo", photo);
      } catch {
        deps.log?.("SHOT_RETRY", { scene: scene.index, kind: "photo" });
      } finally {
        await rm(raw, { force: true });
      }
    }
    if (shot) {
      used.add(shot.sourceId);
      recent.push(shot.sourceId);
      if (recent.length > RECENT_WINDOW) recent.shift();
      if (shot.kind === "video") videos++; else photos++;
    } else missing++;
    shots.push(shot);
    await deps.onProgress?.(shots.length, scenes.length);
  }
  deps.log?.("SHOTS", { scenes: scenes.length, videos, photos, missing });
  return shots;
}

// ---------------------------------------------------------------- production deps (ffmpeg + fetch)

function ffmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}`)); });
  });
}

const ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "25", "-movflags", "+faststart"];
const FILL = "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080";

/** Clip → exact length: optional slow-down, cover-crop to 16:9, and the last frame held if the source still ends early. */
export async function renderClipFfmpeg(src: string, dest: string, seconds: number, speed: number) {
  const slow = speed < 1 ? `setpts=PTS/${speed.toFixed(3)},` : "";
  await ffmpeg(["-i", src, "-vf", `${slow}${FILL},fps=25,tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)}`, "-t", seconds.toFixed(3), ...ENCODE, dest], 10 * 60_000);
}

/** Photo → slow zoom in / zoom out / pan, alternating per scene; upscaled first so the motion stays smooth. */
export async function renderPhotoFfmpeg(src: string, dest: string, seconds: number, variant: number) {
  const frames = Math.ceil(seconds * 25);
  const step = (0.15 / frames).toFixed(6);
  const moves = [
    `z='min(1+${step}*on,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='max(1.15-${step}*on,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.12':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
    `z='1.12':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
  ];
  const vf = `scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan=${moves[variant % moves.length]}:d=${frames}:s=1920x1080:fps=25`;
  await ffmpeg(["-loop", "1", "-i", src, "-vf", vf, "-frames:v", String(frames), ...ENCODE, dest], 10 * 60_000);
}

/** Download with a timeout and one retry; only https URLs from the stock provider are fetched. */
export async function downloadToFile(url: string, dest: string) {
  if (!/^https:\/\//.test(url)) throw new Error("bad url");
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`download ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
