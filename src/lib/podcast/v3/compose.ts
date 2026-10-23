/**
 * Podcast 3.0 — composición de video con FFmpeg (sin Remotion para estos planos: cada plano es un filtro simple).
 * LÍMITE HONESTO: HeyGen genera cada avatar hablando POR SEPARADO. El two-shot y el «sobre el hombro» se COMPONEN:
 * quien habla = su clip con lip-sync; quien escucha = un fotograma fijo (o clip en reposo) de su avatar. No hay
 * interacción física ni lip-sync simultáneo de dos avatares en un mismo render del proveedor.
 */
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ffmpeg } from "./ffmpeg";
import type { Shot } from "./editorial";
import type { StudioSet } from "./spec";

export const FPS = 25;
export type Frame = { w: number; h: number };
export const frameFor = (format: "16:9" | "9:16", small = false): Frame =>
  format === "9:16" ? (small ? { w: 360, h: 640 } : { w: 1080, h: 1920 }) : (small ? { w: 640, h: 360 } : { w: 1920, h: 1080 });

const SET_COLORS: Record<StudioSet, [string, string, string]> = {
  estudio_oscuro: ["0x0b1020", "0x1d2a4a", "0x3a2f1f"],
  estudio_calido: ["0x2a1810", "0x5a3420", "0x6b4a2a"],
  biblioteca: ["0x1b140c", "0x3b2a18", "0x4a3520"],
  neon: ["0x0a0418", "0x3a0a5a", "0x0a3a5a"],
  minimalista: ["0xd8d8d8", "0xf2f2f2", "0x9a9a9a"],
};

const ENC = (small: boolean) => ["-c:v", "libx264", "-preset", small ? "ultrafast" : "veryfast", "-crf", small ? "30" : "22", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an"];

let fontCache: string | null = null;
/** Fuente sin caracteres especiales en la ruta (drawtext no tolera comas/espacios sin escapar). */
export async function fontFile(dir: string): Promise<string> {
  if (fontCache && existsSync(fontCache)) return fontCache;
  const found = spawnSync("fc-match", ["-f", "%{file}", "sans:bold"], { encoding: "utf8" }).stdout?.trim();
  const candidates = [found, "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].filter(Boolean) as string[];
  const src = candidates.find((c) => existsSync(c));
  if (!src) throw new Error("No hay fuente para subtítulos (instala fonts-dejavu-core).");
  const dst = path.join(dir, "font" + path.extname(src));
  await copyFile(src, dst);
  return (fontCache = dst);
}

/** Fondo del set virtual (degradado + mesa + luces), generado una vez por set y formato. */
export async function setBackground(dir: string, set: StudioSet, fr: Frame): Promise<string> {
  const out = path.join(dir, `set-${set}-${fr.w}x${fr.h}.png`);
  if (existsSync(out)) return out;
  const [c0, c1, desk] = SET_COLORS[set];
  const vf = `drawbox=x=0:y=ih*0.78:w=iw:h=ih*0.22:c=${desk}@0.95:t=fill,drawbox=x=iw*0.08:y=ih*0.08:w=iw*0.02:h=ih*0.5:c=white@0.10:t=fill,drawbox=x=iw*0.9:y=ih*0.08:w=iw*0.02:h=ih*0.5:c=white@0.10:t=fill`;
  await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `gradients=s=${fr.w}x${fr.h}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${fr.w}:y1=${fr.h}:d=1`, "-vf", vf, "-frames:v", "1", out]);
  return out;
}

export type ShotSources = {
  /** Clip de avatar (con lip-sync) que cubre el plano, recortado al tramo del turno; null si el plano no es de avatar. */
  speakingClip?: string | null;
  /** Fotograma fijo del interlocutor (para two-shot / sobre el hombro). */
  listenerStill?: string | null;
  image?: string | null;
  title?: string;
  subtitle?: string | null;
};

const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** Renderiza un plano a un MP4 normalizado de exactamente `frames` fotogramas. */
export async function renderShot(dir: string, idx: number, shot: Shot, frames: number, src: ShotSources, o: { set: StudioSet; frame: Frame; swap: boolean; small: boolean; fade: boolean }): Promise<string> {
  const out = path.join(dir, `shot-${String(idx).padStart(4, "0")}.mp4`);
  const { w, h } = o.frame;
  const secs = (frames / FPS).toFixed(3);
  const font = await fontFile(dir);
  const bg = await setBackground(dir, o.set, o.frame);
  const fs = Math.round(h * (w > h ? 0.04 : 0.028));
  const textFilter = async (name: string, text: string, y: string, size: number, box = true) => {
    const f = path.join(dir, `${name}-${idx}.txt`);
    await writeFile(f, wrap(text, w > h ? 60 : 32));
    return `drawtext=fontfile='${esc(font)}':textfile='${esc(f)}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}:line_spacing=6${box ? ":box=1:boxcolor=black@0.55:boxborderw=12" : ""}`;
  };
  const post: string[] = [];
  if (shot.label) post.push((await textFilter("tag", shot.label, "h*0.05", Math.round(fs * 0.9))).replace("x=(w-text_w)/2", "x=w*0.04"));
  if (src.subtitle) {
    // Subtítulos paginados: bloques de ≤2 líneas repartidos en el plano en proporción a sus caracteres.
    const pages = subtitlePages(src.subtitle, w > h ? 60 : 32);
    const totalChars = pages.reduce((n, p) => n + p.length, 0) || 1;
    let acc = 0;
    for (const [k, page] of pages.entries()) {
      const a = acc / totalChars * (frames / FPS), b = (acc + page.length) / totalChars * (frames / FPS); acc += page.length;
      post.push((await textFilter(`sub${k}`, page, "h*0.86-text_h", fs)) + `:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
    }
  }
  if (o.fade && frames > 2 * Math.round(FPS * 0.25)) post.push(`fade=t=in:st=0:d=0.25,fade=t=out:st=${(frames / FPS - 0.25).toFixed(3)}:d=0.25`);
  const tail = (label: string) => `${label}${post.length ? "," + post.join(",") : ""},format=yuv420p[v]`;
  let args: string[];
  const bgIn = ["-loop", "1", "-t", secs, "-i", bg];
  // Lugar de cada participante en el set (invertible).
  const leftIsA = !o.swap;
  switch (shot.kind) {
    case "avatar_a": case "avatar_b": {
      if (!src.speakingClip) throw new Error(`Plano de avatar sin clip (${shot.turn_id}).`);
      const bw = Math.round(w * (w > h ? 0.62 : 0.9)), bh = Math.round(h * (w > h ? 0.8 : 0.62));
      args = [...bgIn, "-i", src.speakingClip, "-filter_complex",
        `[1:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1[a];[0:v][a]overlay=(W-w)/2:(H-h)*0.45:shortest=0,${tail("trim=end_frame=" + frames)}`];
      break;
    }
    case "two_shot": {
      if (!src.speakingClip || !src.listenerStill) throw new Error(`Two-shot sin fuentes (${shot.turn_id}).`);
      const vertical = h > w;
      const bw = Math.round(vertical ? w * 0.84 : w * 0.42), bh = Math.round(vertical ? h * 0.38 : h * 0.66);
      const speakerFirst = (shot.speaker === "A") === leftIsA;
      const [p1, p2] = vertical ? [`(W-w)/2:H*0.08`, `(W-w)/2:H*0.5`] : [`W*0.06:(H-h)*0.42`, `W*0.52:(H-h)*0.42`];
      args = [...bgIn, "-i", src.speakingClip, "-loop", "1", "-t", secs, "-i", src.listenerStill, "-filter_complex",
        `[1:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1[s];[2:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1,eq=brightness=-0.04[l];` +
        `[0:v][s]overlay=${speakerFirst ? p1 : p2}[x];[x][l]overlay=${speakerFirst ? p2 : p1},${tail("trim=end_frame=" + frames)}`];
      break;
    }
    case "over_shoulder": {
      if (!src.speakingClip || !src.listenerStill) throw new Error(`Sobre el hombro sin fuentes (${shot.turn_id}).`);
      // Quien escucha: primer término, oscurecido, desenfocado y espejado (silueta de espaldas aproximada).
      const fw = Math.round(w * (w > h ? 0.55 : 0.8)), fh = Math.round(h * (w > h ? 0.75 : 0.5));
      const lw = Math.round(w * 0.5), lh = Math.round(h * 0.7);
      const speakerRight = (shot.speaker === "A") === leftIsA ? false : true;
      args = [...bgIn, "-i", src.speakingClip, "-loop", "1", "-t", secs, "-i", src.listenerStill, "-filter_complex",
        `[1:v]scale=${fw}:${fh}:force_original_aspect_ratio=increase,crop=${fw}:${fh},setsar=1[s];` +
        `[2:v]scale=${lw}:${lh}:force_original_aspect_ratio=increase,crop=${lw}:${lh},hflip,boxblur=12:2,eq=brightness=-0.35:saturation=0.3,setsar=1[l];` +
        `[0:v][s]overlay=${speakerRight ? "W*0.40" : "W*0.05"}:(H-h)*0.35[x];[x][l]overlay=${speakerRight ? "-W*0.08" : "W*0.58"}:H-h*0.85,${tail("trim=end_frame=" + frames)}`];
      break;
    }
    case "imagen": case "archivo": case "recreacion": {
      if (!src.image) throw new Error(`Plano de imagen sin imagen (${shot.turn_id}).`);
      const z = (0.12 / Math.max(1, frames)).toFixed(6);
      args = ["-loop", "1", "-i", src.image, "-filter_complex",
        `[0:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='min(1+${z}*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${FPS},${tail("trim=end_frame=" + frames)}`];
      break;
    }
    case "titulo": {
      const t = await textFilter("title", src.title ?? "", "(h-text_h)/2", Math.round(fs * 1.6), false);
      args = [...bgIn, "-filter_complex", `[0:v]${t},${tail("trim=end_frame=" + frames)}`];
      break;
    }
    default: {
      args = [...bgIn, "-filter_complex", `[0:v]eq=brightness=-0.1,${tail("trim=end_frame=" + frames)}`];
    }
  }
  await ffmpeg(["-y", "-v", "error", ...args, "-map", "[v]", "-frames:v", String(frames), ...ENC(o.small), out]);
  return out;
}

export function wrap(text: string, width: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = []; let cur = "";
  for (const wd of words) { if ((cur + " " + wd).trim().length > width) { if (cur) lines.push(cur); cur = wd; } else cur = (cur + " " + wd).trim(); }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

export function subtitlePages(text: string, width: number): string[] {
  const lines = wrap(text, width).split("\n");
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2).join("\n"));
  return pages;
}

/** Fotogramas por plano con límites redondeados de forma acumulada: el total coincide con el audio (sincronía A/V). */
export function shotFrames(shots: Pick<Shot, "start" | "end">[], totalSeconds: number): number[] {
  const total = Math.round(totalSeconds * FPS);
  return shots.map((s, i) => {
    const a = Math.round(s.start * FPS), b = i === shots.length - 1 ? total : Math.round(s.end * FPS);
    return Math.max(1, b - a);
  });
}

/** Concatena planos y multiplexa el master de audio (AAC 192k, faststart). */
export async function muxEpisode(dir: string, clips: string[], master: string, out: string, small: boolean): Promise<string> {
  const list = path.join(dir, "clips.txt");
  await writeFile(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
  const video = path.join(dir, "video.mp4");
  await ffmpeg(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
  await ffmpeg(["-y", "-v", "error", "-i", video, "-i", master, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", small ? "128k" : "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", out]);
  return out;
}
