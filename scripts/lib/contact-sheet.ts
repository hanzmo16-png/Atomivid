/**
 * Hojas de contacto (miniaturas etiquetadas) para REVISIÓN VISUAL humana o
 * del agente — la coincidencia de palabras clave solo sirve para encontrar
 * candidatos, no para aprobarlos. Las hojas se emiten en el log de Actions
 * como base64 troceado (el agente que revisa no puede descargar artifacts
 * ni llegar a Pexels/Wikimedia desde su entorno), entre marcadores:
 *
 *   @@SHEET <nombre> <parte>/<total> <base64>
 *
 * decodeSheetsFromLog() las reconstruye a partir del texto del log.
 */
import { spawn } from "node:child_process";

export type SheetTile = { image: Buffer; label: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function buildContactSheet(
  tiles: SheetTile[],
  opts: { columns?: number; tileWidth?: number; tileHeight?: number; title?: string } = {},
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const columns = opts.columns ?? 4;
  const tw = opts.tileWidth ?? 320;
  const th = opts.tileHeight ?? 180;
  const labelH = 40;
  const titleH = opts.title ? 34 : 0;
  const rows = Math.max(1, Math.ceil(tiles.length / columns));
  const width = columns * tw;
  const height = titleH + rows * (th + labelH);
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (const [i, tile] of tiles.entries()) {
    const left = (i % columns) * tw;
    const top = titleH + Math.floor(i / columns) * (th + labelH);
    const thumb = await sharp(tile.image).resize(tw, th, { fit: "contain", background: "#222" }).jpeg().toBuffer().catch(() => null);
    if (thumb) composites.push({ input: thumb, left, top });
    const per = Math.floor(tw / 7.8);
    const [l1, l2] = [tile.label.slice(0, per), tile.label.slice(per, per * 2)];
    const svg = `<svg width="${tw}" height="${labelH}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000"/><text x="4" y="16" font-family="DejaVu Sans, sans-serif" font-size="13" fill="#fff">${esc(l1)}</text><text x="4" y="33" font-family="DejaVu Sans, sans-serif" font-size="13" fill="#ccc">${esc(l2)}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top + th });
  }
  if (opts.title) {
    const svg = `<svg width="${width}" height="${titleH}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#333"/><text x="8" y="23" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#fff">${esc(opts.title.slice(0, 150))}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  return sharp({ create: { width, height, channels: 3, background: "#111" } })
    .composite(composites)
    .jpeg({ quality: 72 })
    .toBuffer();
}

export function emitSheet(name: string, jpeg: Buffer, chunk = 3000): void {
  const b64 = jpeg.toString("base64");
  const parts = Math.ceil(b64.length / chunk);
  for (let i = 0; i < parts; i++) console.log(`@@SHEET ${name} ${i + 1}/${parts} ${b64.slice(i * chunk, (i + 1) * chunk)}`);
}

export function decodeSheetsFromLog(log: string): Map<string, Buffer> {
  const parts = new Map<string, string[]>();
  for (const line of log.split("\n")) {
    const m = /@@SHEET (\S+) (\d+)\/(\d+) (\S+)/.exec(line);
    if (!m) continue;
    const arr = parts.get(m[1]) ?? new Array<string>(Number(m[3])).fill("");
    arr[Number(m[2]) - 1] = m[4];
    parts.set(m[1], arr);
  }
  const out = new Map<string, Buffer>();
  for (const [name, arr] of parts) if (arr.every(Boolean)) out.set(name, Buffer.from(arr.join(""), "base64"));
  return out;
}

/** Fotograma de un video en disco en el segundo `t`, escalado a `width` px. */
export function frameAt(file: string, t: number, width = 480): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 && chunks.length > 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg_frame_${code}_${t}`))));
  });
}

export function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file]);
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`ffprobe_${code}`))));
  });
}
