import { test } from "node:test";
import assert from "node:assert/strict";
import { chapters, describe, parseSrt, sourcesMarkdown, toSrt, toVtt } from "./youtube-package";

const beats = [0, 1, 2, 3].map((i) => ({ index: i, text: `Bloque ${i}. Más texto.` }));
const segs = [
  { beatIndex: 0, startSeconds: 0.4, endSeconds: 30 }, { beatIndex: 1, startSeconds: 30, endSeconds: 35 },
  { beatIndex: 2, startSeconds: 35, endSeconds: 90 }, { beatIndex: 3, startSeconds: 90, endSeconds: 200 },
];
test("capítulos: 0:00, fusiona <10 s, ≥3", () => {
  const c = chapters(beats, segs);
  assert.equal(c[0].start, 0);
  assert.deepEqual(c.map((x) => x.start), [0, 35, 90]);
});
test("capítulos: menos de 3 → ninguno (YouTube los ignoraría)", () => {
  assert.deepEqual(chapters(beats.slice(0, 2), segs.slice(0, 2)), []);
});
test("SRT↔VTT ida y vuelta conserva tiempos", () => {
  const cues = [{ start: 1.25, end: 3.5, text: "hola" }, { start: 3600.001, end: 3601, text: "fin" }];
  assert.deepEqual(parseSrt(toSrt(cues)), cues);
  assert.match(toVtt(cues), /^WEBVTT\n\n00:00:01\.250 --> 00:00:03\.500/);
});
test("fuentes: nunca inventa licencia; separa evidencia/ilustración/recreación", () => {
  const md = sourcesMarkdown([
    { sceneId: "a", kind: "evidence", provider: "commons", license: "CC BY-SA 4.0", author: "X" },
    { sceneId: "b", kind: "illustration", provider: "pexels" },
    { sceneId: "c", kind: "recreation", provider: "openai" },
  ]);
  assert.match(md, /CC BY-SA 4.0/);
  assert.equal((md.match(/no declarada/g) ?? []).length, 2);
  assert.match(md, /Recreación generada \(IA\) — no es registro real \(1\)/);
});
test("descripción derivada del guion y capítulos", () => {
  const d = describe({ topic: "Nubes: cómo llueve", beats, chapters: [{ start: 0, title: "A" }], sources: [] });
  assert.equal(d.title, "Nubes");
  assert.match(d.description, /^Bloque 0\./);
  assert.match(d.description, /0:00 A/);
});
