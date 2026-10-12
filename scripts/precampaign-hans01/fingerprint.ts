/**
 * Perceptual fingerprint of a photo, safe to print in a public log: two 64-bit hashes (difference and average hash
 * on a grayscale thumbnail) plus the mean colour of a 3×3 grid. None of it can be turned back into the image.
 * Used to compare the avatar's stored photo with a private copy (Drive) without moving the image itself.
 * Same ffmpeg filter chain on both sides; small ffmpeg-version differences show up as a few bits of Hamming distance.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const sh = promisify(execFile);

async function raw(file: string, w: number, h: number, fmt: "gray" | "rgb24") {
  const { stdout } = await sh("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${w}:${h}:flags=area,format=${fmt}`, "-frames:v", "1", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 20 });
  return stdout as unknown as Buffer;
}
const hex = (bits: boolean[]) => bits.reduce((s, _, i) => (i % 4 ? s : s + parseInt(bits.slice(i, i + 4).map(b => (b ? "1" : "0")).join(""), 2).toString(16)), "");

export async function photoFingerprint(file: string) {
  const d = await raw(file, 9, 8, "gray");
  const dhash = hex(Array.from({ length: 64 }, (_, i) => d[Math.floor(i / 8) * 9 + (i % 8)] < d[Math.floor(i / 8) * 9 + (i % 8) + 1]));
  const a = await raw(file, 8, 8, "gray");
  const mean = a.reduce((t, x) => t + x, 0) / 64;
  const ahash = hex(Array.from(a, x => x > mean));
  const g = await raw(file, 3, 3, "rgb24");
  return { dhash, ahash, grid3x3: Array.from(g) };
}

export function hamming(a: string, b: string) {
  let n = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } }
  return n;
}

if (process.argv[1]?.endsWith("fingerprint.ts") && process.argv[2]) photoFingerprint(process.argv[2]).then(f => console.log(JSON.stringify(f)));
