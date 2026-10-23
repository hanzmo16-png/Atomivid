/**
 * Podcast 3.0 — audio: une los turnos (sin cortar voces), mezcla música por ambiente con ducking por sidechain,
 * fundidos, cortinas de entrada/transición, ambiente opcional, y masteriza a −16 LUFS integrado con true peak ≤ −1 dBTP
 * (objetivo −1,5). Todo con ffmpeg local: sin red ni costo.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { measureLoudness, masteringFilter } from "@/lib/video/audio-master";
import { ffmpeg, ffprobeDuration, ebur128 } from "./ffmpeg";
import { AMBIENT_FILES, STINGS, trackFor, type BundledTrack } from "./music-library";
import type { Mood } from "./spec";

export const MASTER = { lufs: -16, tolerance: 1, truePeakMax: -1, truePeakTarget: -1.5 } as const;
export type TurnAudio = { turn_id: string; speaker: "A" | "B"; file: string; pause_after?: number };
export type TimelineEntry = { turn_id: string; speaker: "A" | "B"; start: number; end: number };

/** Une los turnos (48 kHz mono, voz a −18 LUFS aprox.) con pausas e intro/cola; devuelve la línea de tiempo exacta. */
export async function assembleVoice(dir: string, turns: TurnAudio[], introSeconds: number, outroSeconds: number): Promise<{ file: string; timeline: TimelineEntry[]; duration: number }> {
  const parts: string[] = [];
  const timeline: TimelineEntry[] = [];
  const silence = async (name: string, d: number) => {
    const f = path.join(dir, name);
    await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", d.toFixed(3), "-c:a", "pcm_s16le", f]);
    return f;
  };
  let t = 0;
  if (introSeconds > 0) { parts.push(await silence("intro.wav", introSeconds)); t += introSeconds; }
  for (const [i, tr] of turns.entries()) {
    const f = path.join(dir, `turn-${String(i).padStart(3, "0")}.wav`);
    await ffmpeg(["-y", "-v", "error", "-i", tr.file, "-ac", "1", "-ar", "48000", "-af", "loudnorm=I=-18:TP=-3:LRA=11", "-c:a", "pcm_s16le", f]);
    const d = await ffprobeDuration(f);
    timeline.push({ turn_id: tr.turn_id, speaker: tr.speaker, start: t, end: t + d });
    parts.push(f); t += d;
    const pause = tr.pause_after ?? (i < turns.length - 1 ? (turns[i + 1].speaker !== tr.speaker ? 0.35 : 0.5) : 0);
    if (pause > 0) { parts.push(await silence(`pause-${i}.wav`, pause)); t += pause; }
  }
  if (outroSeconds > 0) { parts.push(await silence("outro.wav", outroSeconds)); t += outroSeconds; }
  const list = path.join(dir, "voice.txt");
  await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const file = path.join(dir, "voice.wav");
  await ffmpeg(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", file]);
  return { file, timeline, duration: await ffprobeDuration(file) };
}

export type MixOptions = {
  musicDir: string; enabled: boolean; mood: Mood; volumeDb: number; stings: boolean; ambient: "ninguno" | keyof typeof AMBIENT_FILES;
  /** Momentos (s) de transición de bloque donde suena la cortina corta (nunca encima de voz: se colocan en pausas). */
  transitions: number[]; duckDb?: number;
};

/** Grafo de mezcla (exportado para pruebas sin ffmpeg). Entradas: 0 voz, 1 música, 2 cortina, 3 transición, 4 ambiente. */
export function mixGraph(o: { total: number; musicGainDb: number; stings: boolean; transitions: number[]; ambient: boolean; music: boolean }): { graph: string; inputs: number } {
  const g: string[] = [];
  g.push(`[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=2[v][sc]`);
  const mixIn = ["[v]"];
  if (o.music) {
    g.push(`[1:a]volume=${o.musicGainDb.toFixed(2)}dB,afade=t=in:d=2.5,afade=t=out:st=${Math.max(0, o.total - 4).toFixed(3)}:d=4[bed]`);
    // Ducking: la música baja bajo la voz (≈10–14 dB) y vuelve en las pausas; ataque/relajación suaves (sin bombeo).
    g.push(`[bed][sc]sidechaincompress=threshold=0.012:ratio=12:attack=25:release=450:knee=4[duck]`);
    mixIn.push("[duck]");
  } else g.push(`[sc]anullsink`);
  if (o.music && o.stings) {
    g.push(`[2:a]volume=-3dB[s0]`); mixIn.push("[s0]");
    if (o.transitions.length) {
      g.push(`[3:a]asplit=${o.transitions.length}${o.transitions.map((_, i) => `[tr${i}]`).join("")}`);
      o.transitions.forEach((ts, i) => { const ms = Math.round(ts * 1000); g.push(`[tr${i}]adelay=${ms}|${ms}[td${i}]`); mixIn.push(`[td${i}]`); });
    }
  }
  if (o.ambient) { g.push(`[4:a]volume=-6dB,afade=t=in:d=3,afade=t=out:st=${Math.max(0, o.total - 3).toFixed(3)}:d=3[amb]`); mixIn.push("[amb]"); }
  g.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=first:normalize=0:dropout_transition=0[mix]`);
  return { graph: g.join(";"), inputs: 5 };
}

/** Mezcla y masteriza. Devuelve master WAV + exportes y medición (LUFS, TP, recortes). */
export async function mixAndMaster(dir: string, voiceFile: string, o: MixOptions): Promise<{ master: string; lufs: number; truePeak: number; clipped: number; track: BundledTrack | null }> {
  const total = await ffprobeDuration(voiceFile);
  const track = o.enabled ? trackFor(o.mood) : null;
  // Pistas a −20 LUFS; la ganancia lleva la cama a volume_db LUFS antes del ducking.
  const musicGainDb = o.volumeDb - -20;
  const ambient = o.ambient !== "ninguno";
  const { graph } = mixGraph({ total, musicGainDb, stings: o.stings, transitions: o.transitions, ambient, music: o.enabled });
  const m = (f: string) => path.join(o.musicDir, f);
  const inputs = ["-i", voiceFile,
    "-stream_loop", "-1", "-t", total.toFixed(3), "-i", track ? m(track.file) : m(trackFor("documental").file),
    "-i", m(STINGS.intro), "-i", m(STINGS.transicion),
    "-stream_loop", "-1", "-t", total.toFixed(3), "-i", m(ambient ? AMBIENT_FILES[o.ambient as keyof typeof AMBIENT_FILES] : AMBIENT_FILES.lluvia)];
  const mix = path.join(dir, "mix.wav");
  await ffmpeg(["-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "[mix]", "-ar", "48000", "-c:a", "pcm_s24le", mix]);
  const master = path.join(dir, "master.wav");
  const before = await measureLoudness(mix);
  await ffmpeg(["-y", "-v", "error", "-i", mix, "-af", masteringFilter(before, MASTER.truePeakTarget), "-ar", "48000", "-c:a", "pcm_s24le", master]);
  let q = await ebur128(master);
  if (q.truePeak > MASTER.truePeakMax || q.clipped > 0) {
    const fixed = path.join(dir, "master-tp.wav");
    await ffmpeg(["-y", "-v", "error", "-i", master, "-af", `volume=${(MASTER.truePeakTarget - q.truePeak - 0.3).toFixed(2)}dB`, "-c:a", "pcm_s24le", fixed]);
    q = await ebur128(fixed);
    return { master: fixed, ...q, track };
  }
  return { master, ...q, track };
}

/** Exporte de audio separado (MP3 192 kbps o WAV 24 bit). */
export async function exportAudio(master: string, out: string, kind: "mp3" | "wav"): Promise<string> {
  await ffmpeg(["-y", "-v", "error", "-i", master, ...(kind === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "192k"] : ["-c:a", "pcm_s24le"]), out]);
  return out;
}

/** Transiciones de bloque: pausas entre turnos de distinto hablante cada ~N turnos (la cortina cae en la pausa). */
export function transitionTimes(timeline: TimelineEntry[], every = 6): number[] {
  const out: number[] = [];
  for (let i = every; i < timeline.length; i += every) out.push(Math.max(0, timeline[i - 1].end + 0.02));
  return out;
}
