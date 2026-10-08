/**
 * Zero-cost audio pilot (no provider, no network, no writes outside a temp dir).
 * Exercises the REAL long-form narration mechanics with the fixture voice (a tone, NOT speech):
 * TTS splitting (incl. a > 9000-char beat and leading "…"), per-chunk synthesis, stitching with word
 * re-timing, MP3/AAC export and two-pass loudness mastering to the product target (-16 LUFS, -1.5 dBTP).
 * Diction and voice quality CANNOT be judged here: that needs a paid ElevenLabs call.
 */
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitNarrationIntoSafeChunks, stitchNarrationParts, MAX_TTS_CHARS_PER_CALL, type NarrationPart } from "../src/lib/video/long-form/timeline";
import { fixtureVoiceProvider } from "../src/lib/providers/voice/fixture";
import { LOUDNESS_TARGET, masterAudioLoudness, measureLoudness } from "../src/lib/video/audio-master";

const sentence = (i: number) => `En el bosque número ${i} alguien encontró una huella que nadie supo explicar del todo.`;
const beats = [
  "… " + Array.from({ length: 12 }, (_, i) => sentence(i)).join(" "),
  Array.from({ length: 130 }, (_, i) => sentence(100 + i)).join(" "),
  "¿Qué queda entonces? " + Array.from({ length: 8 }, (_, i) => sentence(500 + i)).join(" "),
];

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "audio-pilot-"));
  const parts: NarrationPart[] = [];
  const report: Record<string, unknown>[] = [];
  for (const [b, text] of beats.entries()) {
    const chunks = splitNarrationIntoSafeChunks(text);
    const words = text.split(/\s+/).filter(Boolean).length;
    const chunkWords = chunks.reduce((n, c) => n + c.split(/\s+/).filter(Boolean).length, 0);
    for (const c of chunks) {
      const r = await fixtureVoiceProvider.synthesize(c, "es");
      parts.push({ audioBuffer: r.audioBuffer, mimeType: r.mimeType, extension: r.extension, durationSeconds: r.durationSeconds, words: r.words });
    }
    report.push({ beat: b, chars: text.length, chunks: chunks.length, maxChunk: Math.max(...chunks.map((c) => c.length)), withinLimit: chunks.every((c) => c.length <= MAX_TTS_CHARS_PER_CALL), wordsPreserved: words === chunkWords, leadingPunctuationKept: chunks[0].startsWith(text.trim()[0]) });
  }
  const stitched = stitchNarrationParts(parts);
  const monotonic = stitched.words.every((w, i) => w.endSeconds >= w.startSeconds && (i === 0 || w.startSeconds >= stitched.words[i - 1].startSeconds));
  const wav = path.join(dir, "narration.wav");
  writeFileSync(wav, stitched.audioBuffer);
  const mastered = path.join(dir, "episode.m4a");
  const m = await masterAudioLoudness(wav, mastered, { truePeakMarginDb: 1 });
  const after = await measureLoudness(mastered);
  console.log("BEATS", JSON.stringify(report));
  console.log("STITCH", JSON.stringify({ parts: parts.length, words: stitched.words.length, seconds: Math.round(stitched.durationSeconds), monotonicTimings: monotonic }));
  console.log("LOUDNESS", JSON.stringify({ target: LOUDNESS_TARGET, before: m.before, after, withinLufs: Math.abs(after.integratedLufs - LOUDNESS_TARGET.INTEGRATED_LUFS) <= 1, truePeakOk: after.truePeakDbtp <= LOUDNESS_TARGET.TRUE_PEAK_DBTP, episodeBytes: statSync(mastered).size }));
  console.log("COST_USD 0 (fixture voice: tone, not speech)");
}
main().catch((e) => { console.error("pilot failed:", e instanceof Error ? e.message : e); process.exitCode = 1; });
