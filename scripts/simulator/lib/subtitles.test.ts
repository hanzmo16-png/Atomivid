import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSubtitles, parseSilencedetect } from "./subtitles";

const words = [
  { text: "Hola", startSeconds: 0, endSeconds: 0.4 },
  { text: "mundo.", startSeconds: 0.4, endSeconds: 0.8 },
  { text: "Otra", startSeconds: 1.6, endSeconds: 2.0 },
  { text: "frase.", startSeconds: 2.0, endSeconds: 2.4 },
];
const base = { words, audioDurationSeconds: 2.5, videoDurationSeconds: 3, silences: [{ startSeconds: 0.8, endSeconds: 1.6 }] };

test("subtítulos alineados con pausa respetada: sin incidencias", () => {
  const r = analyzeSubtitles({ ...base, cues: [{ text: "Hola mundo.", startSeconds: 0, endSeconds: 0.8 }, { text: "Otra frase.", startSeconds: 1.6, endSeconds: 2.4 }] });
  assert.deepEqual(r.issues, []);
  assert.equal(r.metrics.silencesWithoutSubtitle, 1, "un silencio sin subtítulo es legítimo");
});

test("detecta solape, deriva, texto perdido, fuera de límites y subtítulo dentro del silencio", () => {
  const r = analyzeSubtitles({ ...base, cues: [{ text: "Hola mundo.", startSeconds: 0, endSeconds: 1.4 }, { text: "Otra frase.", startSeconds: 1.3, endSeconds: 2.9 }] });
  const codes = new Set(r.issues.map((i) => i.code));
  for (const c of ["overlap", "drift", "beyond_audio", "subtitle_during_silence", "final_offset"]) assert.ok(codes.has(c), c);
  const lost = analyzeSubtitles({ ...base, cues: [{ text: "Hola mundo.", startSeconds: 0, endSeconds: 0.8 }] });
  assert.ok(lost.issues.some((i) => i.code === "words_without_subtitle"));
  const disorder = analyzeSubtitles({ ...base, cues: [{ text: "Otra frase.", startSeconds: 1.6, endSeconds: 2.4 }, { text: "Hola mundo.", startSeconds: 0, endSeconds: 0.8 }] });
  assert.ok(disorder.issues.some((i) => i.code === "out_of_order" || i.code === "text_mismatch"));
});

test("detecta deriva acumulada progresiva", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ text: `w${i}.`, startSeconds: i, endSeconds: i + 0.5 }));
  const cues = many.map((w, i) => ({ text: w.text, startSeconds: w.startSeconds + i * 0.004, endSeconds: w.endSeconds + i * 0.004 }));
  const r = analyzeSubtitles({ cues, words: many, audioDurationSeconds: 21, videoDurationSeconds: 21, silences: [] });
  assert.ok(r.issues.some((i) => i.code === "cumulative_drift"));
});

test("parsea silencedetect de ffmpeg", () => {
  const out = parseSilencedetect("[silencedetect @ 0x1] silence_start: 0.81\n[silencedetect @ 0x1] silence_end: 1.59 | silence_duration: 0.78\n");
  assert.deepEqual(out, [{ startSeconds: 0.81, endSeconds: 1.59 }]);
});
