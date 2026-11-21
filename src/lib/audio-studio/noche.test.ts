/**
 * Endgame nocturno: duración 10/20/30 min, idiomas, pautas sin reemplazar y duración real frente a la elegida.
 * Reglas puras (sin red, sin proveedor, USD 0).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInput, draftOutline, estimate, hasOutlineCues, newProject, readinessIssues, WORDS_PER_MINUTE } from "./model";
import { durationVerdict } from "./editor-rules";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-21T05:00:00.000Z";
const words = (n: number, base: string) => { const w = base.split(" "); return Array.from({ length: n }, (_, i) => w[i % w.length]).join(" "); };
function script(minutes: number, duo: boolean, lang: "es" | "en") {
  const base = lang === "es" ? "Respira y vuelve a lo que depende de ti con calma y valor cada día" : "Breathe and return to what depends on you with calm and courage every day";
  const per = 100, n = Math.round((minutes * WORDS_PER_MINUTE) / per);
  const label = (i: number) => (duo ? `${lang === "es" ? "Voz" : "Voice"} ${(i % 2) + 1}: ` : "");
  return ["## A", ...Array.from({ length: n }, (_, i) => `${label(i)}${words(per, base)}.`)].join("\n\n");
}
function project(minutes: number, duo: boolean, lang: "es" | "en", s: string) {
  const p = newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1", ownerId: A, now: NOW, title: "Noche", voiceCount: duo ? 2 : 1, language: lang });
  return applyInput(p, { targetMinutes: minutes, script: s, budgetUsd: 100, language: lang, voiceCount: duo ? 2 : 1 }, NOW);
}

test("10, 20 y 30 minutos, en español e inglés, con una y dos voces: un guion de esa longitud queda listo", () => {
  for (const lang of ["es", "en"] as const) for (const duo of [false, true]) for (const m of [10, 20, 30]) {
    const p = project(m, duo, lang, script(m, duo, lang));
    assert.equal(p.targetMinutes, m, `${lang} ${duo} ${m}`);
    const e = estimate(p);
    assert.ok(Math.abs(e.estimatedMinutes - m) <= 0.5, `${lang} ${m}: ${e.estimatedMinutes}`);
    const issues = readinessIssues(p, e);
    assert.deepEqual(issues, [], `${lang} duo=${duo} ${m} min: ${issues.join(" | ")}`);
  }
});

test("30 minutos con un guion de 5: no se puede generar y el motivo dice la duración", () => {
  const p = project(30, false, "es", script(5, false, "es"));
  assert.ok(readinessIssues(p, estimate(p)).some((x) => /duración estimada \(5[.,]?\d* min\) se aleja del objetivo \(30 min\)/.test(x)));
});

test("pautas de la estructura inicial: si quedan en el guion no se genera (se narrarían y cobrarían)", () => {
  for (const lang of ["es", "en"] as const) for (const vc of [1, 2] as const) {
    const outline = draftOutline("Calma", 10, vc, lang);
    assert.ok(hasOutlineCues(outline), `${lang} ${vc}`);
    const s = `${outline}\n\n${script(10, vc === 2, lang)}`;
    const p = project(10, vc === 2, lang, s);
    assert.ok(readinessIssues(p, estimate(p)).some((x) => /pautas de la estructura inicial/.test(x)), `${lang} ${vc}`);
  }
  assert.equal(hasOutlineCues(script(10, true, "es")), false);
  assert.equal(hasOutlineCues("Responde con calma y añade tu matiz personal."), false, "frases parecidas escritas por la persona no cuentan");
});

test("duración real frente a la elegida: avisa si se aleja más de un 20 % (mínimo 1 min)", () => {
  assert.equal(durationVerdict(30 * 60, 30).ok, true);
  assert.equal(durationVerdict(26 * 60, 30).ok, true);
  const short = durationVerdict(5 * 60, 30);
  assert.equal(short.ok, false);
  assert.match(short.message!, /dura 5 min y elegiste 30 min: alarga/);
  const long = durationVerdict(7.5 * 60, 5);
  assert.equal(long.ok, false);
  assert.match(long.message!, /acorta/);
  assert.equal(durationVerdict(5.8 * 60, 5).ok, true, "en 5 min la tolerancia mínima es 1 min");
  assert.equal(durationVerdict(0, 30).ok, true, "sin audio no hay aviso");
});
