/**
 * Genera un contact sheet (mosaico de frames representativos) del MP4
 * final de VIDEO #001, vía ffmpeg — sin dependencias nuevas (mismo binario
 * ya usado por long-form-qc.ts/audio-master.ts). Sirve dos propósitos:
 *  1. Artifact "contact sheet" pedido en el reporte final (sección de
 *     entregables de GitHub Actions).
 *  2. Material para la revisión visual adicional (sección 11 del encargo):
 *     un vistazo rápido a consistencia entre los 11 AI_RECREATION,
 *     anacronismos, manos/caras problemáticas, texto cortado, etc.
 *
 * No inventa timestamps: reparte los frames UNIFORMEMENTE a lo largo de
 * la duración real del video (ffprobe), nunca asume una duración fija.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { probeVideoFile } from "../src/lib/video/long-form/long-form-qc";

const run = promisify(execFile);

function parseArgs(argv: string[]) {
  const get = (name: string, fallback?: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  };
  const mp4 = get("mp4");
  if (!mp4) throw new Error("Uso: contact-sheet-video-001.ts --mp4=<ruta.mp4> [--output=<ruta.png>] [--frames=45] [--cols=9]");
  return {
    mp4,
    output: get("output", mp4.replace(/\.mp4$/, ".contact-sheet.png")) as string,
    frames: Number(get("frames", "45")),
    cols: Number(get("cols", "9")),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[contact-sheet] MP4="${args.mp4}" frames=${args.frames} cols=${args.cols}`);

  const probe = await probeVideoFile(args.mp4);
  if (!(probe.durationSeconds > 0)) {
    throw new Error(`contact-sheet-video-001: no se pudo leer una duración válida de "${args.mp4}" (ffprobe: ${probe.durationSeconds}s)`);
  }

  const rows = Math.ceil(args.frames / args.cols);
  // fps del filtro `fps=` para obtener exactamente `frames` capturas
  // uniformes a lo largo de la duración real — nunca un número fijo de
  // frames por segundo que dependería de la duración real del video.
  const samplingFps = args.frames / probe.durationSeconds;

  mkdirSync(path.dirname(args.output), { recursive: true });

  await run(
    ffmpegInstaller.path,
    [
      "-i",
      args.mp4,
      "-vf",
      `fps=${samplingFps},scale=320:-1,tile=${args.cols}x${rows}`,
      "-frames:v",
      "1",
      "-y",
      args.output,
    ],
    { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );

  console.log(`[contact-sheet] escrito: ${args.output} (${rows * args.cols} celdas, ${args.cols}x${rows})`);
}

main().catch((err) => {
  console.error("[contact-sheet] fallo:", err);
  process.exit(1);
});
