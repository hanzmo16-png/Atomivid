/**
 * Verificación de SOLO LECTURA de la biblioteca de música (bucket privado
 * `music-library`): para cada pista registrada en manifest.ts firma una URL
 * temporal, descarga el archivo, valida que sea audio real y mide duración,
 * loudness integrado y pico con ffprobe/ffmpeg. No sube, borra ni modifica
 * nada; no llama a ningún proveedor de pago.
 *
 * Resultado: tabla en el log + music-library-report.json, con el carácter
 * asignado a cada pista en audiovisual/music.ts. Una medición NO equivale a
 * escuchar: la revisión auditiva sigue pendiente.
 *
 * Uso (GitHub Actions, con los secretos de Supabase): npx tsx scripts/verify-music-library.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MUSIC_MANIFEST } from "../src/lib/providers/music/manifest";
import { signMusicLibraryUrl } from "../src/lib/providers/music/storage";
import { validateAudioBuffer } from "../src/lib/providers/music/validate";
import { createServiceClient } from "../src/lib/supabase/service";
import { TRACK_CHARACTER, compatibleTrackCount } from "../src/lib/video/audiovisual/music";
import { MUSIC_DIRECTION_IDS } from "../src/lib/video/audiovisual/catalog";

const run = promisify(execFile);

async function measure(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const lufs = /I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf("Summary")))?.[1];
  const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(stderr.slice(stderr.lastIndexOf("Summary")))?.[1];
  return { durationSeconds: Number(Number(stdout.trim()).toFixed(2)), integratedLufs: lufs ? Number(lufs) : null, truePeakDbtp: peak ? Number(peak) : null };
}

async function main() {
  const service = createServiceClient();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-verify-"));
  const rows: Record<string, unknown>[] = [];
  for (const track of MUSIC_MANIFEST) {
    const row: Record<string, unknown> = { id: track.id, title: track.title, character: TRACK_CHARACTER[track.id]?.character ?? null };
    try {
      const url = await signMusicLibraryUrl(service, track.storagePath);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const validation = validateAudioBuffer(buffer);
      if (!validation.valid) throw new Error(validation.reason);
      const file = path.join(dir, `${track.id}.${validation.format}`);
      await fs.writeFile(file, buffer);
      Object.assign(row, { available: true, format: validation.format, bytes: buffer.byteLength, ...(await measure(file)) });
    } catch (err) {
      Object.assign(row, { available: false, error: err instanceof Error ? err.message : String(err) });
    }
    rows.push(row);
    console.log(`@@TRACK ${JSON.stringify(row)}`);
  }
  const available = new Set(rows.filter((r) => r.available).map((r) => r.id));
  const byDirection = Object.fromEntries(
    MUSIC_DIRECTION_IDS.map((d) => [d, compatibleTrackCount(MUSIC_MANIFEST.filter((t) => available.has(t.id)), d)]),
  );
  const summary = { registered: MUSIC_MANIFEST.length, available: available.size, missing: rows.filter((r) => !r.available).map((r) => r.id), compatibleAvailableByDirection: byDirection };
  console.log(`@@SUMMARY ${JSON.stringify(summary)}`);
  await fs.writeFile("music-library-report.json", JSON.stringify({ summary, tracks: rows }, null, 2));
  if (summary.missing.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Falló la verificación de la biblioteca de música:", err);
  process.exit(1);
});
