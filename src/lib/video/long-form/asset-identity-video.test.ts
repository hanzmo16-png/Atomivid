/**
 * Portabilidad del ffmpeg de la identidad perceptual de VIDEO (T-20261126-0322). El dHash de un video se calcula con
 * un fotograma extraído por ffmpeg; si se invocaba por nombre («ffmpeg») y el ejecutor no lo tenía en PATH, el dHash
 * se perdía en silencio y la deduplicación visual dejaba de funcionar. El repositorio ya declara el binario versionado
 * (@ffmpeg-installer/ffmpeg): debe usarse aunque PATH no tenga ffmpeg.
 *
 * Sin red ni proveedores: los MP4 se generan aquí con el binario empaquetado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { contentIdentity, hammingHex } from "./asset-identity";

const dir = mkdtempSync(join(tmpdir(), "asset-identity-video-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
function mp4(name: string, src: string, faststart = false): Buffer {
  const out = join(dir, name);
  execFileSync(ffmpegInstaller.path, ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-t", "3", "-pix_fmt", "yuv420p", ...(faststart ? ["-movflags", "+faststart"] : []), out]);
  return readFileSync(out);
}
const moovAfterMdat = (b: Buffer) => b.indexOf("moov") > b.indexOf("mdat");

/** Ejecuta `fn` con PATH sin ningún ffmpeg (y FFMPEG_BIN opcional), restaurando el entorno después. */
async function withoutPathFfmpeg<T>(fn: () => Promise<T>, ffmpegBin?: string): Promise<T> {
  const prev = { PATH: process.env.PATH, FFMPEG_BIN: process.env.FFMPEG_BIN };
  process.env.PATH = join(dir, "sin-ffmpeg");
  if (ffmpegBin === undefined) delete process.env.FFMPEG_BIN; else process.env.FFMPEG_BIN = ffmpegBin;
  try { return await fn(); } finally {
    if (prev.PATH === undefined) delete process.env.PATH; else process.env.PATH = prev.PATH;
    if (prev.FFMPEG_BIN === undefined) delete process.env.FFMPEG_BIN; else process.env.FFMPEG_BIN = prev.FFMPEG_BIN;
  }
}

const bars = mp4("bars.mp4", "testsrc=s=160x90:r=10");
const barsFast = mp4("bars-fast.mp4", "testsrc=s=160x90:r=10", true);
const noise = mp4("mandel.mp4", "mandelbrot=s=160x90:r=10");

test("fixture: el MP4 por defecto trae el índice (moov) al final, como los de Pexels", () => {
  assert.ok(moovAfterMdat(bars), "moov después de mdat");
  assert.ok(!moovAfterMdat(barsFast), "faststart: moov antes de mdat");
});

test("RED/GREEN: sin ffmpeg en PATH, el dHash del video se calcula con el binario empaquetado", async () => {
  const id = await withoutPathFfmpeg(() => contentIdentity(bars, "video"));
  assert.equal(id.dhashUnavailable, undefined, `dHash perdido: ${id.dhashUnavailable}`);
  assert.match(id.dhash ?? "", /^[0-9a-f]{16}$/);
  assert.match(id.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("MP4 con índice al final y con faststart dan el mismo fotograma (dHash igual o casi igual)", async () => {
  const [a, b] = await withoutPathFfmpeg(() => Promise.all([contentIdentity(bars, "video"), contentIdentity(barsFast, "video")]));
  assert.ok(a.dhash && b.dhash);
  assert.ok(hammingHex(a.dhash, b.dhash) <= 2, `${a.dhash} vs ${b.dhash}`);
  const c = await withoutPathFfmpeg(() => contentIdentity(noise, "video"));
  assert.ok(c.dhash && a.dhash && hammingHex(a.dhash, c.dhash) > 6, "otro contenido no se confunde con un duplicado");
});

test("FFMPEG_BIN inválido no apaga el dHash: se usa el siguiente binario disponible", async () => {
  const id = await withoutPathFfmpeg(() => contentIdentity(bars, "video"), join(dir, "no-existe", "ffmpeg"));
  assert.match(id.dhash ?? "", /^[0-9a-f]{16}$/, String(id.dhashUnavailable));
});

test("recurso inválido o fallo de extracción: sin dHash y con motivo explícito (nunca un hash inventado)", async () => {
  const bad = await withoutPathFfmpeg(() => contentIdentity(Buffer.from("esto no es un mp4"), "video"));
  assert.equal(bad.dhash, undefined);
  assert.match(bad.dhashUnavailable ?? "", /ffmpeg_frame/);
  assert.match(bad.sha256 ?? "", /^[0-9a-f]{64}$/, "la identidad exacta (SHA-256) se conserva");
  const empty = await withoutPathFfmpeg(() => contentIdentity(Buffer.alloc(0), "video"));
  assert.equal(empty.dhash, undefined);
  assert.ok(empty.dhashUnavailable);
});
