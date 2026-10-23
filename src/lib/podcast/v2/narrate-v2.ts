/**
 * Podcast 2.0 — narración REAL por segmentos (servidor/worker). Cada turno pasa por el mismo gate de pagos
 * que la narración estándar (ledger + resultado persistido por clave texto+voz+modelo+ajustes): reintentar o
 * reanudar nunca vuelve a pagar un segmento guardado; un resultado ambiguo bloquea (ReconciliationRequired).
 * Los turnos con grabación propia NO llaman a TTS: se leen del Storage del dueño y se verifica su hash.
 * Montaje: silencios por intención narrativa (postproceso, sin etiquetas que el modelo ignore), música
 * opcional con licencia verificable y ducking, master de dos pasadas (masterAudioLoudness, −16 LUFS).
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPricingConfig } from "@/lib/billing/pricing";
import { gatedVoiceSynthesize, storedVoiceResult, type PaidCallDeps } from "@/lib/paid-calls/gated-providers";
import type { VoiceProvider, WordTiming } from "@/lib/providers/types";
import { masterAudioLoudness, measureLoudness, type LoudnessMeasurement } from "@/lib/video/audio-master";
import { ceilLedgerUsd } from "@/lib/supply/anthropic-cost";
import { podcastAudioPath, podcastLedgerProject, type PodcastEpisode } from "../episode";
import { NarrationCapError } from "../narrate";
import { directSegments, type DirectionPlan, type SegmentDirection } from "./director";
import { planMusic, LOUDNESS, type MusicTrack } from "./music";
import { PodcastProduction } from "./production";

export type VoiceIdentity = { voiceId: string; modelId: string; voiceSettingsJson: string };
export type ProductionDeps = Omit<PaidCallDeps, "requestId"> & {
  /** Proveedor + identidad para una voz concreta y, en estilo emocional, sus ajustes por segmento. */
  voiceFor: (voiceId: string, settings: { stability: number; style: number } | null) => { provider: VoiceProvider; identity: VoiceIdentity };
  modelId: string;
  /** Lee una grabación propia del Storage del dueño (la ruta ya se validó al adjuntarla). */
  getRecording: (storagePath: string) => Promise<Buffer>;
  putAudio: (path: string, bytes: Buffer, contentType: string) => Promise<void>;
  capUsd?: number | null;
  music?: { dir: string; library: MusicTrack[] } | null;
};

export type TimelineEntry = { turn_id: string; speaker: "A" | "B"; text: string; start: number; end: number; source: "tts" | "own_recording"; sha256: string; reused: boolean; words: WordTiming[] };
export type ProductionOutcome = { audioPath: string; bytes: number; sha256: string; durationSeconds: number; costUsd: number; reusedSegments: number; ttsSegments: number; ownSegments: number;
  ttsCalls: { turn_id: string; voice_id: string }[]; loudness: LoudnessMeasurement; timeline: TimelineEntry[]; plan: DirectionPlan };

const run = (args: string[]) => new Promise<void>((res, rej) => { const p = spawn(process.env.FFMPEG_BIN || "ffmpeg", args); let e = ""; p.stderr.on("data", (d) => { e += d; }); p.on("close", (c) => c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${e.slice(-400)}`))); });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Plan de dirección para la producción. Estándar = pausas neutras y ritmo 1.0; emocional = director completo. */
export function planProduction(p: PodcastProduction, modelId: string): DirectionPlan {
  const parts = new Map(p.participants.map((x) => [x.id, x]));
  return directSegments(p.turns.map((t) => {
    const who = parts.get(t.speaker)!;
    const own = !!who.recordings[t.id];
    return { segment_id: t.id, speaker_id: t.speaker, text: t.text, voice_id: own ? `own-${t.speaker}` : who.voice_id!, provider: own ? "own_recording" as const : "elevenlabs" as const, model: own ? "own_recording" : modelId };
  }), { mode: p.style === "emotional" ? "full" : "reference" });
}

const settingsFor = (s: SegmentDirection, style: PodcastProduction["style"]) => style === "emotional" ? { stability: s.native.stability, style: s.native.style } : null;
const speedFor = (s: SegmentDirection, style: PodcastProduction["style"]) => style === "emotional" && s.pace !== 1 ? s.pace : undefined;

export async function narrateProduction(deps: ProductionDeps, episode: Pick<PodcastEpisode, "id" | "user_id" | "language">, raw: unknown): Promise<ProductionOutcome> {
  const prod = PodcastProduction.parse(raw);
  // Música pedida sin ninguna pista con licencia disponible: se detiene ANTES de cualquier llamada de pago en vez de
  // entregar (y cobrar) un episodio sin la música que se eligió.
  if (prod.music && !licensedMusic(deps.music).length) throw new MusicUnavailableError();
  const plan = planProduction(prod, deps.modelId);
  const parts = new Map(prod.participants.map((x) => [x.id, x]));
  const requestId = podcastLedgerProject(episode.id);
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  const dir = await mkdtemp(path.join(tmpdir(), "podcast-v2-"));
  let costUsd = 0, newSpendUsd = 0, reused = 0;
  const ttsCalls: ProductionOutcome["ttsCalls"] = [];
  const pieces: { seg: SegmentDirection; file: string; source: TimelineEntry["source"]; sha256: string; reused: boolean; words: WordTiming[]; dur: number }[] = [];
  try {
    for (const seg of plan.segments) {
      const who = parts.get(seg.speaker_id as "A" | "B")!;
      const rec = who.recordings[seg.segment_id];
      if (rec) {
        const bytes = await deps.getRecording(rec);
        const f = path.join(dir, `${seg.segment_id}.src`); await writeFile(f, bytes);
        const wav = path.join(dir, `${seg.segment_id}.wav`);
        await run(["-y", "-v", "error", "-i", f, "-ar", "48000", "-ac", "1", "-bitexact", wav]);
        pieces.push({ seg, file: wav, source: "own_recording", sha256: sha(bytes), reused: true, words: [], dur: await durationOf(wav) });
        continue;
      }
      const { provider, identity } = deps.voiceFor(who.voice_id!, settingsFor(seg, prod.style));
      if (identity.voiceId !== who.voice_id) throw new Error("VOICE_IDENTITY_MISMATCH"); // nunca una voz distinta a la del participante
      const speed = speedFor(seg, prod.style);
      const estimatedCostUsd = ceilLedgerUsd(seg.text.length / 1000 * rate);
      const gateDeps = { ...deps, requestId, voiceProvider: provider, voiceIdentity: identity };
      if (deps.capUsd != null && newSpendUsd + estimatedCostUsd > deps.capUsd + 1e-9 && !(await storedVoiceResult(gateDeps, seg.text, episode.language, speed))) {
        throw new NarrationCapError(deps.capUsd, ceilLedgerUsd(newSpendUsd));
      }
      const r = await gatedVoiceSynthesize({ ...gateDeps, estimatedCostUsd }, seg.text, episode.language, speed);
      costUsd += r.costUsd;
      if (r.reused) reused++; else { newSpendUsd += Math.max(estimatedCostUsd, r.costUsd); ttsCalls.push({ turn_id: seg.segment_id, voice_id: identity.voiceId }); }
      const f = path.join(dir, `${seg.segment_id}.src.${r.extension}`); await writeFile(f, r.audioBuffer);
      const wav = path.join(dir, `${seg.segment_id}.wav`);
      await run(["-y", "-v", "error", "-i", f, "-ar", "48000", "-ac", "1", "-bitexact", wav]);
      pieces.push({ seg, file: wav, source: "tts", sha256: sha(r.audioBuffer), reused: r.reused, words: r.words, dur: await durationOf(wav) });
    }
    // Montaje con silencios por intención (postproceso)
    const list: string[] = [], timeline: TimelineEntry[] = [];
    let t = 0;
    const silence = async (ms: number) => { const f = path.join(dir, `sil${ms}.wav`); if (!existsSync(f)) await run(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(ms / 1000), f]); return f; };
    for (const p of pieces) {
      list.push(await silence(Math.max(1, p.seg.pause_before_ms)));
      const start = t + p.seg.pause_before_ms / 1000;
      list.push(p.file);
      list.push(await silence(Math.max(1, p.seg.pause_after_ms)));
      p.seg.actual_duration_ms = Math.max(1, Math.round(p.dur * 1000));
      timeline.push({ turn_id: p.seg.segment_id, speaker: p.seg.speaker_id as "A" | "B", text: p.seg.text, start, end: start + p.dur, source: p.source, sha256: p.sha256, reused: p.reused,
        words: p.words.map((w) => ({ ...w, startSeconds: w.startSeconds + start, endSeconds: w.endSeconds + start })) });
      t = start + p.dur + p.seg.pause_after_ms / 1000;
    }
    const concat = path.join(dir, "voice.txt"), voice = path.join(dir, "voice.wav");
    await writeFile(concat, list.map((f) => `file '${f}'`).join("\n"));
    await run(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concat, "-c", "pcm_s16le", voice]);
    let mixIn = voice;
    if (prod.music && deps.music) mixIn = await mixMusic(dir, voice, plan, deps.music);
    const out = path.join(dir, "episode.m4a");
    const m = await masterAudioLoudness(mixIn, out, { truePeakMarginDb: 1, faststart: true });
    const bytes = await readFile(out);
    const audioPath = podcastAudioPath(episode);
    await deps.putAudio(audioPath, bytes, "audio/mp4");
    return { audioPath, bytes: bytes.length, sha256: sha(bytes), durationSeconds: t, costUsd: ceilLedgerUsd(costUsd), reusedSegments: reused, ttsSegments: pieces.filter((p) => p.source === "tts").length,
      ownSegments: pieces.filter((p) => p.source === "own_recording").length, ttsCalls, loudness: m.after, timeline, plan };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function durationOf(f: string): Promise<number> {
  // WAV PCM mono 16-bit 48 kHz → bytes/96000 (sin ffprobe extra). Cabecera estándar de 44 bytes.
  const size = readFileSync(f).length;
  return Math.max(0, (size - 44) / 96000);
}

export class MusicUnavailableError extends Error {
  constructor() { super("La música de fondo no está disponible ahora mismo. Desactívala para generar el episodio; no se ha cobrado nada."); this.name = "MusicUnavailableError"; }
}

/** Pistas utilizables: el archivo existe y figura en LICENSES.md de la carpeta (nunca una sin licencia). */
export function licensedMusic(music: { dir: string; library: MusicTrack[] } | null | undefined): MusicTrack[] {
  if (!music) return [];
  const licenses = existsSync(path.join(music.dir, "LICENSES.md")) ? readFileSync(path.join(music.dir, "LICENSES.md"), "utf8") : "";
  return music.library.filter((l) => licenses.includes(l.file) && existsSync(path.join(music.dir, l.file)));
}

/** Música bajo la voz: cues por emoción, solo pistas con licencia en LICENSES.md, ducking por sidechain. */
async function mixMusic(dir: string, voice: string, plan: DirectionPlan, music: { dir: string; library: MusicTrack[] }): Promise<string> {
  const lib = licensedMusic(music);
  if (!lib.length) throw new MusicUnavailableError();
  const cues = planMusic(plan, lib);
  const parts: string[] = [];
  for (const [i, c] of cues.entries()) {
    const d = Math.max(0.05, (c.end_ms - c.start_ms) / 1000), f = path.join(dir, `m${i}.wav`);
    const fade = Math.min(c.fade_in_ms / 1000, d / 3);
    if (!c.track) await run(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(d), f]);
    else await run(["-y", "-v", "error", "-stream_loop", "-1", "-i", path.join(music.dir, c.track), "-t", String(d), "-ac", "1", "-ar", "48000", "-af", `volume=${c.bed_db}dB,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, d - fade)}:d=${fade}`, f]);
    parts.push(f);
  }
  const lst = path.join(dir, "music.txt"), bed = path.join(dir, "music.wav"), mix = path.join(dir, "mix.wav");
  await writeFile(lst, parts.map((f) => `file '${f}'`).join("\n"));
  await run(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, bed]);
  await run(["-y", "-v", "error", "-i", voice, "-i", bed, "-filter_complex", `[0:a]asplit=2[v][sc];[1:a][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[m];[v][m]amix=inputs=2:duration=first:dropout_transition=0,volume=2[a]`, "-map", "[a]", mix]);
  return mix;
}

/** Comprobación posterior obligatoria: el archivo renderizado NO prueba audio terminado. */
export async function verifyMaster(file: string) {
  const l = await measureLoudness(file);
  const issues: string[] = [];
  if (Math.abs(l.integratedLufs - LOUDNESS.integrated_lufs) > 1.5) issues.push(`LUFS ${l.integratedLufs}`);
  if (l.truePeakDbtp > LOUDNESS.true_peak_max_db) issues.push(`TP ${l.truePeakDbtp}`);
  if (l.lra > 15) issues.push(`LRA ${l.lra}`);
  return { ...l, ok: issues.length === 0, issues };
}

/** Subtítulos con hablante a partir de la línea de tiempo guardada (sin llamadas). */
export function speakerSubtitles(timeline: TimelineEntry[], names: Record<string, string>): { start: number; end: number; text: string }[] {
  return timeline.map((e) => ({ start: e.start, end: e.end, text: `[${names[e.speaker] ?? e.speaker}] ${e.words.length ? e.words.map((w) => w.text).join(" ") : e.text}`.trim() }));
}
