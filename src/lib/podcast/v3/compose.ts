/**
 * Podcast 3.0 — composición de video con FFmpeg (sin Remotion para estos planos: cada plano es un filtro simple).
 * LÍMITE HONESTO: HeyGen genera cada avatar hablando POR SEPARADO. Los planos de conversación se COMPONEN en un estudio
 * compartido (studios.ts): cada persona se recorta de su fondo original (matte.py) y se sienta en su lado de la mesa;
 * quien habla = su clip con lip-sync; quien escucha = su foto fija recortada. No hay lip-sync simultáneo de dos avatares.
 */
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ffmpeg } from "./ffmpeg";
import type { Shot } from "./editorial";
import type { StudioSet } from "./spec";
import { STUDIO_H, STUDIO_W, cameraFor, gradeFilter, legacyStudio, placeInSeat, seatOf, studioDef, studioFrontPath, studioPlatePath, type Camera, type Matte, type StudioDef } from "./studios";

export const FPS = 25;
export type Frame = { w: number; h: number };
export const frameFor = (format: "16:9" | "9:16", small = false): Frame =>
  format === "9:16" ? (small ? { w: 360, h: 640 } : { w: 1080, h: 1920 }) : (small ? { w: 640, h: 360 } : { w: 1920, h: 1080 });

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

/** Ruta absoluta de un recurso del estudio (el worker y las pruebas se ejecutan desde la raíz del repositorio). */
const asset = (p: string) => path.resolve(process.cwd(), p);

/**
 * Fondo y primer término de una cámara, renderizados UNA vez por estudio, cámara y formato (PNG): el fondo recortado,
 * escalado y desenfocado según el acercamiento; en vertical, el plano general va en una franja sobre el propio estudio
 * muy desenfocado. Así cada plano solo mueve a las personas (rápido y sin recalcular el fondo en cada fotograma).
 */
export async function cameraPlates(dir: string, st: StudioDef, cam: Camera, fr: Frame): Promise<{ bg: string; front: string }> {
  const key = `${st.id}-${fr.w}x${fr.h}-${cam.zoom.toFixed(4)}-${cam.ox}-${cam.oy}`;
  const bg = path.join(dir, `cam-${key}-fondo.png`), front = path.join(dir, `cam-${key}-frente.png`);
  if (existsSync(bg) && existsSync(front)) return { bg, front };
  const sw = Math.round(STUDIO_W * cam.zoom), sh = Math.round(STUDIO_H * cam.zoom);
  // Recorte en coordenadas del estudio ANTES de escalar (un acercamiento ×3 no escala el estudio entero).
  const view = (blur: number) => {
    if (cam.oy < 0) return `scale=${sw}:${sh}${blur ? `,gblur=sigma=${blur.toFixed(2)}` : ""}`;
    const cw = Math.min(STUDIO_W, fr.w / cam.zoom), ch = Math.min(STUDIO_H, fr.h / cam.zoom);
    return `crop=${cw.toFixed(2)}:${ch.toFixed(2)}:${(cam.ox / cam.zoom).toFixed(2)}:${(cam.oy / cam.zoom).toFixed(2)},scale=${fr.w}:${fr.h}${blur ? `,gblur=sigma=${blur.toFixed(2)}` : ""}`;
  };
  if (cam.oy < 0) {
    // Vertical, plano general: relleno con el estudio desenfocado y oscurecido + la franja nítida en el centro.
    await ffmpeg(["-y", "-v", "error", "-i", asset(studioPlatePath(st.id)), "-filter_complex",
      `[0:v]split[a][b];[a]scale=-2:${fr.h},crop=${fr.w}:${fr.h},gblur=sigma=24,eq=brightness=-0.18[f];[b]${view(0)}[m];[f][m]overlay=0:${-cam.oy}`, "-frames:v", "1", bg]);
    await ffmpeg(["-y", "-v", "error", "-i", asset(studioFrontPath(st.id)), "-filter_complex",
      `color=c=black@0:s=${fr.w}x${fr.h},format=rgba[c];[0:v]${view(0)},format=rgba[m];[c][m]overlay=0:${-cam.oy}:format=auto`, "-frames:v", "1", front]);
  } else {
    await ffmpeg(["-y", "-v", "error", "-i", asset(studioPlatePath(st.id)), "-vf", view(cam.blur), "-frames:v", "1", bg]);
    await ffmpeg(["-y", "-v", "error", "-i", asset(studioFrontPath(st.id)), "-vf", `format=rgba,${view(cam.frontBlur)}`, "-frames:v", "1", "-pix_fmt", "rgba", front]);
  }
  return { bg, front };
}

/** Fondo del estudio para títulos y transiciones (el estudio elegido, ligeramente desenfocado). */
export async function setBackground(dir: string, set: StudioSet, fr: Frame): Promise<string> {
  const st = studioDef(legacyStudio(set));
  const out = path.join(dir, `set-${st.id}-${fr.w}x${fr.h}.png`);
  if (existsSync(out)) return out;
  await ffmpeg(["-y", "-v", "error", "-i", asset(studioPlatePath(st.id)), "-vf", `scale=${fr.w}:${fr.h}:force_original_aspect_ratio=increase,crop=${fr.w}:${fr.h},gblur=sigma=2`, "-frames:v", "1", out]);
  return out;
}

export type ShotSources = {
  /** Clip de avatar (con lip-sync) que cubre el plano, recortado al tramo del turno; null si el plano no es de avatar. */
  speakingClip?: string | null;
  /** Fotograma fijo del interlocutor (para two-shot / sobre el hombro). */
  listenerStill?: string | null;
  /** Recortes (persona sin su fondo original) de quien habla y de quien escucha, para el estudio compartido. */
  speakerMatte?: Matte | null;
  listenerMatte?: Matte | null;
  image?: string | null;
  title?: string;
  subtitle?: string | null;
  /** Palabras del turno con sus tiempos (s desde el inicio del PLANO): subtítulos sincronizados con la voz. */
  words?: SubtitleWord[];
  /** Tarjeta explícita (idea del turno) cuando su imagen no superó la verificación. */
  card?: string | null;
};
export type SubtitleWord = { text: string; start: number; end: number };

/**
 * Páginas de subtítulos (≤ 2 líneas) a partir de las palabras con tiempo: cada página aparece cuando se dice su primera
 * palabra y se queda hasta la siguiente (o el final del plano). Sin tiempos, reparto proporcional a los caracteres.
 */
export function timedPages(words: SubtitleWord[], width: number, shotSeconds: number): { text: string; start: number; end: number }[] {
  const pages: { text: string; start: number; end: number }[] = [];
  let lines: string[] = [""], start = Math.max(0, words[0]?.start ?? 0);
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + " " + w.text).trim().length > width) {
      if (lines.length === 2) { pages.push({ text: lines.join("\n").trim(), start, end: Math.max(start, w.start) }); lines = [w.text]; start = Math.max(0, w.start); continue; }
      lines.push(w.text);
    } else lines[lines.length - 1] = (cur + " " + w.text).trim();
  }
  if (lines.join("").trim()) pages.push({ text: lines.join("\n").trim(), start, end: shotSeconds });
  for (let i = 0; i < pages.length - 1; i++) pages[i].end = pages[i + 1].start;
  return pages.filter((p) => p.end > p.start + 0.05);
}

/**
 * Movimiento de cámara sutil para una imagen fija (quien escucha, fondos de transición): empuje lento + deriva
 * lateral suave, sinusoidal y continuo. NO anima la boca ni simula gestos: solo encuadre (sin falso lip-sync).
 * Se trabaja a 2× para que el redondeo de zoompan no produzca temblor visible. `seed` desfasa la deriva entre planos.
 */
export function stillMotion(w: number, h: number, frames: number, seed = 0): string {
  const zp = Math.max(FPS * 6, frames * 2), xp = Math.max(FPS * 5, Math.round(frames * 1.3)); // periodos (fotogramas): nunca un vaivén rápido
  const ph = ((seed % 7) / 7 * 2 * Math.PI).toFixed(3);
  return `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},` +
    `zoompan=z='1.04+0.03*sin(2*PI*on/${zp}+${ph})':x='iw/2-(iw/zoom/2)+iw*0.012*sin(2*PI*on/${xp}+${ph})':y='ih/2-(ih/zoom/2)+ih*0.006*sin(2*PI*on/${zp}+${ph})':d=${frames}:s=${w}x${h}:fps=${FPS}`;
}

const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** Renderiza un plano a un MP4 normalizado de exactamente `frames` fotogramas. */
export async function renderShot(dir: string, idx: number, shot: Shot, frames: number, src: ShotSources, o: { set: StudioSet; frame: Frame; swap: boolean; small: boolean; fade: boolean }): Promise<string> {
  const out = path.join(dir, `shot-${String(idx).padStart(4, "0")}.mp4`);
  const { w, h } = o.frame;
  const secs = (frames / FPS).toFixed(3);
  const font = await fontFile(dir);
  const bg = await setBackground(dir, o.set, o.frame);
  const fs = Math.round(h * (w > h ? 0.04 : 0.028));
  // Un drawtext POR LÍNEA: con varias líneas en un textfile, el ffmpeg del runner (6.1) dibuja el salto de línea como «□»
  // (P1 real). `anchor` fija el borde superior ("top") o inferior ("bottom") del bloque en `y`.
  const textFilter = async (name: string, text: string, y: string, size: number, box = true, anchor: "top" | "bottom" = "top") => {
    const lines = textLines(text, w > h ? 60 : 32);
    const lineH = Math.round(size * 1.25) + (box ? 24 : 6);
    const parts: string[] = [];
    for (const [i, line] of lines.entries()) {
      const f = path.join(dir, `${name}-${idx}-${i}.txt`);
      await writeFile(f, line);
      const ly = anchor === "top" ? `${y}+${i * lineH}` : `${y}-${(lines.length - i) * lineH}`;
      parts.push(`drawtext=fontfile='${esc(font)}':textfile='${esc(f)}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${ly}${box ? ":box=1:boxcolor=black@0.55:boxborderw=12" : ""}`);
    }
    return parts;
  };
  const post: string[] = [];
  if (shot.label) post.push(...(await textFilter("tag", shot.label, "h*0.05", Math.round(fs * 0.9))).map((f) => f.replace("x=(w-text_w)/2", "x=w*0.04")));
  if (src.words?.length) {
    for (const [k, page] of timedPages(src.words, w > h ? 60 : 32, frames / FPS).entries())
      post.push(...(await textFilter(`sub${k}`, page.text, "h*0.93", fs, true, "bottom")).map((f) => f + `:enable='between(t,${page.start.toFixed(3)},${page.end.toFixed(3)})'`));
  } else if (src.subtitle) {
    // Subtítulos paginados: bloques de ≤2 líneas repartidos en el plano en proporción a sus caracteres.
    const pages = subtitlePages(src.subtitle, w > h ? 60 : 32);
    const totalChars = pages.reduce((n, p) => n + p.length, 0) || 1;
    let acc = 0;
    for (const [k, page] of pages.entries()) {
      const a = acc / totalChars * (frames / FPS), b = (acc + page.length) / totalChars * (frames / FPS); acc += page.length;
      post.push(...(await textFilter(`sub${k}`, page, "h*0.93", fs, true, "bottom")).map((f) => f + `:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`));
    }
  }
  if (o.fade && frames > 2 * Math.round(FPS * 0.25)) post.push(`fade=t=in:st=0:d=0.25,fade=t=out:st=${(frames / FPS - 0.25).toFixed(3)}:d=0.25`);
  const tail = (label: string) => `${label}${post.length ? "," + post.join(",") : ""},format=yuv420p[v]`;
  let args: string[];
  const bgIn = ["-loop", "1", "-t", secs, "-i", bg];
  // Una imagen rechazada por la verificación se muestra como tarjeta explícita (rama «default»).
  switch (src.card && !src.image ? "transicion" : shot.kind) {
    case "avatar_a": case "avatar_b": case "two_shot": case "over_shoulder": {
      // Estudio compartido: plano general (los dos a la mesa) o primer plano de quien habla en SU asiento. Un plano
      // «sobre el hombro» de un plan anterior se compone como primer plano (el oyente encima se retiró).
      const sp = shot.speaker;
      if (!sp || !src.speakerMatte) throw new Error(`Plano de conversación sin recorte de quien habla (${shot.turn_id}).`);
      const general = shot.kind === "two_shot";
      if (general && !src.listenerMatte) throw new Error(`Plano general sin recorte de quien escucha (${shot.turn_id}).`);
      const st = studioDef(legacyStudio(o.set));
      const seat = seatOf(st, sp, o.swap);
      const cam = cameraFor(general ? "general" : "primer", seat, seat === st.seats.A ? "izquierda" : "derecha", o.frame);
      const plates = await cameraPlates(dir, st, cam, o.frame);
      const people: { m: Matte; seat: typeof seat }[] = [{ m: src.speakerMatte, seat }];
      if (general) people.push({ m: src.listenerMatte!, seat: seatOf(st, sp === "A" ? "B" : "A", o.swap) });
      const ins = ["-loop", "1", "-t", secs, "-i", plates.bg, "-loop", "1", "-t", secs, "-i", plates.front];
      const parts: string[] = [];
      let base = "[0:v]";
      people.forEach(({ m, seat: s }, k) => {
        const L = placeInSeat(m, s, cam);
        const fi = 2 + k * 2, ai = fi + 1;
        // Foto fija (quien escucha): un fotograma repetido; clip (quien habla): se alarga con su último fotograma si
        // termina antes que el plano.
        // Sin recorte (alfa null, solo pruebas) la persona entra opaca con su encuadre.
        const alpha = m.alpha ?? m.fg;
        if (m.still) ins.push("-loop", "1", "-t", secs, "-i", m.fg, "-loop", "1", "-t", secs, "-i", alpha);
        else ins.push("-i", m.fg, "-i", alpha);
        const pad = m.still ? "" : `,tpad=stop_mode=clone:stop_duration=${secs}`;
        const merge = m.alpha ? `[${fi}:v]format=rgb24${pad}[f${k}];[${ai}:v]format=gray${pad}[a${k}];[f${k}][a${k}]alphamerge` : `[${fi}:v]format=rgba${pad}`;
        parts.push(`${merge},scale=${L.w}:${L.h},${gradeFilter(st)}[p${k}]`);
        parts.push(`${base}[p${k}]overlay=${L.x}:${L.y}:format=auto:eof_action=repeat[b${k}]`);
        base = `[b${k}]`;
      });
      parts.push(`${base}[1:v]overlay=0:0:format=auto,${tail("trim=end_frame=" + frames)}`);
      args = [...ins, "-filter_complex", parts.join(";")];
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
      const t = (await textFilter("title", src.title ?? "", "(h-text_h)/2", Math.round(fs * 1.6), false)).join(",");
      args = ["-i", bg, "-filter_complex", `[0:v]${stillMotion(w, h, frames, idx)},${t},${tail("trim=end_frame=" + frames)}`];
      break;
    }
    default: {
      if (src.card) {
        // Alternativa explícita: la idea del turno sobre el estudio desenfocado (su imagen no superó la verificación).
        const t = (await textFilter("card", src.card, "(h-text_h)/2-h*0.08", Math.round(fs * 1.3), false)).join(",");
        args = ["-i", bg, "-filter_complex", `[0:v]${stillMotion(w, h, frames, idx)},gblur=sigma=8,eq=brightness=-0.22,${t},${tail("trim=end_frame=" + frames)}`];
        break;
      }
      // Transición: el set con un movimiento lento de cámara (un fondo fijo durante todo un turno parecería congelado).
      args = ["-i", bg, "-filter_complex", `[0:v]${stillMotion(w, h, frames, idx)},eq=brightness=-0.1,${tail("trim=end_frame=" + frames)}`];
    }
  }
  await ffmpeg(["-y", "-v", "error", ...args, "-map", "[v]", "-frames:v", String(frames), ...ENC(o.small), out]);
  return out;
}

/** Recorte de los clips de avatar: centrado en horizontal y anclado arriba (la cara está en el tercio superior de un
 *  retrato). El recorte centrado cortaba la cara a la altura de los ojos (prueba real 2026-10-28, sobre el hombro). */
export const FACE_CROP = "(iw-ow)/2:(ih-oh)*0.15";

export function wrap(text: string, width: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = []; let cur = "";
  for (const wd of words) { if ((cur + " " + wd).trim().length > width) { if (cur) lines.push(cur); cur = wd; } else cur = (cur + " " + wd).trim(); }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

/** Líneas ya ajustadas a `width`, sin saltos de línea dentro (cada una va en su propio drawtext). */
export function textLines(text: string, width: number): string[] {
  return wrap(text, width).split("\n").map((l) => l.trim()).filter(Boolean);
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
