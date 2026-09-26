import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const W = 270;
const H = 480;

async function grayFrame(file: string, seconds: number): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  if (stdout.length !== W * H) throw new Error(`Fotograma ilegible en ${seconds.toFixed(2)} s`);
  return stdout;
}

/** Diferencia media absoluta (0–255) entre dos fotogramas, en una franja de filas [top, bottom) expresada como fracción de la altura. */
function bandDiff(a: Buffer, b: Buffer, top: number, bottom: number): number {
  const y0 = Math.floor(top * H);
  const y1 = Math.ceil(bottom * H);
  let sum = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) sum += Math.abs(a[y * W + x] - b[y * W + x]);
  return sum / ((y1 - y0) * W);
}

export type AnimatedShot = { sceneIndex: number; startSeconds: number; endSeconds: number; transitionInFrames: number; source: string };

/**
 * Evidencia TÉCNICA de movimiento dentro de cada escena animada (proveedor
 * simulado): el elemento que el fixture desplaza (franja superior del
 * cuadro) cambia entre dos instantes del mismo plano, mientras una franja
 * de la ilustración sin elemento móvil queda quieta (control: no es un zoom
 * ni un paneo global añadido). Mide solo la ventana donde el plano se ve
 * solo (tras su fundido de entrada y antes del corte). No evalúa calidad.
 */
export async function verifyAnimatedMotion(file: string, shots: AnimatedShot[], fps = 30) {
  if (shots.length === 0) throw new Error("Evidencia inválida: el montaje no tiene planos.");
  const rows: Record<string, unknown>[] = [];
  for (const shot of shots) {
    if (shot.source !== "ai_animation") throw new Error(`Evidencia inválida: la escena ${shot.sceneIndex + 1} no usa el clip animado (${shot.source}).`);
    const t1 = shot.startSeconds + shot.transitionInFrames / fps + 0.1;
    const t2 = Math.min(t1 + 1.5, shot.endSeconds - 0.1);
    if (t2 - t1 < 0.8) throw new Error(`Evidencia inválida: la escena ${shot.sceneIndex + 1} se ve sola menos de 0,8 s.`);
    const [a, b] = await Promise.all([grayFrame(file, t1), grayFrame(file, t2)]);
    const moving = bandDiff(a, b, 0.22, 0.34);
    const still = bandDiff(a, b, 0.4, 0.48);
    rows.push({ scene: shot.sceneIndex + 1, t1: +t1.toFixed(2), t2: +t2.toFixed(2), movingBandDiff: +moving.toFixed(2), stillBandDiff: +still.toFixed(2) });
    if (!(moving > 5)) throw new Error(`Evidencia inválida: sin movimiento dentro de la escena ${shot.sceneIndex + 1} (diferencia ${moving.toFixed(2)}).`);
    if (!(still < 3)) throw new Error(`Evidencia inválida: la escena ${shot.sceneIndex + 1} se mueve entera (diferencia de control ${still.toFixed(2)}); no es movimiento dentro del plano.`);
  }
  console.log(`Movimiento dentro de cada escena animada: ${JSON.stringify(rows)}`);
  return rows;
}
