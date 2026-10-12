import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarCuts, buildAss, ffmpegArgs, planCompose, subtitleLines, twoLines, type Word } from "./compose";

const TEXT = "¿Tienes buenas ideas, pero hacer un video te toma demasiado tiempo? Estamos preparando Atomivid para ayudarte a convertir esas ideas en contenido. Guion, voz, imágenes, subtítulos y la opción de presentar con tu propio avatar. Mira algunos resultados de nuestras pruebas. Estamos afinando la experiencia para que tú también puedas crear. ¿Quieres enterarte del lanzamiento? Síguenos. Atomivid. Tu idea. Tu video. Próximamente.";
function words(rate = 13): Word[] {
  let t = 0.1; const w: Word[] = [];
  for (const x of TEXT.split(" ")) { const d = Math.max(0.18, x.length / rate); w.push({ text: x, startSeconds: t, endSeconds: t + d }); t += d + (/[.?!,]$/.test(x) ? 0.35 : 0.06); }
  return w;
}
const end = (w: Word[]) => w[w.length - 1].endSeconds + 0.2;

test("timeline follows the real narration: contiguous, avatar slots exactly at the cut windows, ends after the voice", () => {
  for (const rate of [11, 13, 16]) {
    const w = words(rate), plan = planCompose(w, end(w));
    const cuts = avatarCuts(w);
    assert.equal(plan.segs[0].start, 0);
    assert.equal(plan.segs[0].end, cuts.apertura.end);
    assert.equal(plan.segs[3].start, cuts.cierre.start);
    assert.equal(plan.segs[3].end, cuts.cierre.end);
    assert.equal(plan.segs[2].start, w.find(x => x.text === "Mira")!.startSeconds, "results scene starts on «Mira»");
    for (let i = 1; i < plan.segs.length; i++) assert.equal(plan.segs[i].start, plan.segs[i - 1].end);
    assert.ok(plan.total > end(w));
  }
});

test("a shorter delivered clip shortens its slot instead of freezing a frame over speech", () => {
  const w = words(), cuts = avatarCuts(w);
  const plan = planCompose(w, end(w), { apertura: cuts.apertura.end - 0.1, cierre: cuts.cierre.end - cuts.cierre.start - 0.1 });
  assert.ok(Math.abs(plan.segs[0].end - (cuts.apertura.end - 0.1)) < 1e-9);
});

test("missing anchor words or a broken narration stop the edit instead of guessing", () => {
  assert.throws(() => planCompose(words().filter(x => x.text !== "Mira"), 30), /compose_word_not_found:Mira/);
  assert.throws(() => planCompose([], 30), /compose_no_narration/);
});

test("subtitles: literal script text, every word once, in order, at most two lines per cue", () => {
  const w = words(), lines = subtitleLines(w);
  assert.equal(lines.map(l => l.text).join(" "), TEXT);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].end - 1e-9, "no overlapping cues");
  for (const l of lines) assert.ok(twoLines(l.text).split("\\N").every(x => x.length <= 30), l.text);
  const ass = buildAss(w);
  assert.match(ass, /Dialogue: 0,0:00:00\.10,/);
  assert.ok(!/[{}]/.test(ass.split("[Events]")[1]));
});

test("ffmpeg graph: master voice is the only speech track, avatar clips' own audio is never mapped", () => {
  const w = words(), args = ffmpegArgs({ animatic: "a.mp4", voice: "v.wav", apertura: "o.mp4", cierre: "c.mp4", ass: "s.ass", out: "f.mp4" }, planCompose(w, end(w)));
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(!/\[2:a\]|\[3:a\]/.test(graph));
  assert.match(graph, /\[1:a\]/);
  assert.ok(args.includes("libx264") && args.includes("aac"));
});
