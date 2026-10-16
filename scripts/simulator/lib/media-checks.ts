import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSilencedetect, type Interval } from "./subtitles";

export type Capture = {
  index: number;
  profile: string;
  compositionId: string;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
  scale: number;
  x264Preset: string | null;
  crf: number | null;
  renderMs: number;
  narrationFile: string | null;
  musicFile: string | null;
  durationSeconds: number;
  scenes: { id: string; startSeconds: number; endSeconds: number; kind: string | null }[];
  captions: { text: string; startSeconds: number; endSeconds: number }[];
  narrationGaps: Interval[];
  stills: { captionIndex: number; text: string; frame: number; withCaptions: string; withoutCaptions: string }[];
};

export function readCaptures(dir: string): (Capture & { dir: string })[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "capture.json")))
    .map((d) => ({ ...(JSON.parse(fs.readFileSync(path.join(dir, d, "capture.json"), "utf8")) as Capture), dir: path.join(dir, d) }))
    .sort((a, b) => a.index - b.index);
}

export function mediaDuration(file: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).toString().trim());
}

export function audioSilences(file: string, minSeconds = 0.5, noiseDb = -45): Interval[] {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, "-f", "null", "-"], { encoding: "utf8" });
  return parseSilencedetect(r.stderr);
}

/** PSNR en la franja de subtítulos (25 % inferior, 70 % central del ancho), donde los dibuja la composición. */
function psnr(a: string, b: string): number {
  const crop = "crop=iw*0.7:ih*0.25:iw*0.15:ih*0.75";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", a, "-i", b, "-lavfi", `[0:v]format=rgb24,${crop}[x];[1:v]format=rgb24,${crop}[y];[x][y]psnr`, "-f", "null", "-"], { encoding: "utf8" });
  const m = r.stderr.match(/average:(inf|[\d.]+)/);
  return m ? (m[1] === "inf" ? 99 : Number(m[1])) : NaN;
}

/**
 * ¿Están los subtítulos DENTRO del MP4? Para cada fotograma de control se
 * extrae ese mismo fotograma del MP4 final y se compara (PSNR) con dos
 * renders del mismo frame: con subtítulos y sin subtítulos. Si el MP4 se
 * parece claramente más a la versión con subtítulos, están incrustados.
 * Se mide solo en la franja de subtítulos. Umbral: ventaja ≥ 3 dB (el valor absoluto depende de la
 * compresión: el perfil estructural CRF 35 sobre texturas sintéticas da PSNR bajos en ambos casos).
 */
export function verifyBurnedCaptions(mp4: string, capture: Capture, workDir: string) {
  const rows = capture.stills.map((st) => {
    const frameFile = path.join(workDir, `mp4-frame-${st.frame}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-vf", `select=eq(n\\,${st.frame})`, "-frames:v", "1", frameFile]);
    const withDb = psnr(frameFile, st.withCaptions);
    const withoutDb = psnr(frameFile, st.withoutCaptions);
    return { frame: st.frame, text: st.text, psnrWithCaptionsDb: withDb, psnrWithoutCaptionsDb: withoutDb, burned: withDb - withoutDb >= 3 };
  });
  return { thresholds: { region: "25% inferior × 70% central", minAdvantageDb: 3 }, rows, allBurned: rows.length > 0 && rows.every((r) => r.burned) };
}
