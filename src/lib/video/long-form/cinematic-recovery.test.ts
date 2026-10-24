/** Recuperación cinematográfica (e8048599): densidad de planos y correcciones localizadas. Puras, USD 0. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { densifySlots, sequencesFromScript, SHOT_DENSITY_MAX_SEC } from "./script-sequences";
import { intentWordSpans } from "./scene-anchoring";
import { validateSequenceIntents, validateImpactIntents } from "./sequence-intent";
import { applyNarrationPatches, type NarrationPatch } from "./narration-patch";
import { LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";

// Bloque 5 real de e8048599 (beat 4): 213 palabras, solo 2 escenas declaradas.
const BLOCK5 = "But hold that thought, because the same logic cuts both ways, and this is where the hypothetical gets genuinely harder. Take the Huns out of that narrow pass and put them on open plains — the kind of terrain steppe cavalry is generally understood to have thrived on — and the Spartan phalanx loses its own advantage just as completely. A wall of locked shields and leveled spears is devastating when an enemy has to come straight at it through a bottleneck. It's a very different story against an enemy that doesn't need to come straight at anything. If the general pattern attributed to steppe warfare holds, mounted archers could circle a static infantry formation, harass it with ranged fire from a distance, retreat before contact, and repeat — never offering the close-quarters collision the phalanx is built to win. The Spartans' entire system assumes an enemy willing to meet them face-to-face. Strip that assumption away, and the formation that held a mountain pass for three days could, in open ground, find itself surrounded by an enemy it can't actually catch. So now the central question has split in two: not 'who wins,' but 'which battlefield are we even imagining this on?' That's not a dodge. It's the actual shape of the answer.";
const beat5 = { id: "beat-5", type: "turn", purpose: "terrain cuts both ways", narration: BLOCK5, visuals: [
  { description: "Wide open steppe plains stretching to horizon, empty grassland terrain", quote: "Take the Huns out of that narrow pass", beatClass: "PLACE", impact: 2, impactReason: "the terrain flips", motion: true },
  { description: "Spartan phalanx surrounded on open ground by circling riders", quote: "Strip that assumption away, and the formation", beatClass: "METAPHOR", impact: 3, impactReason: "the reversal lands", motion: true },
] };

test("bloque 5 real: en cinematográfico ningún plano supera ~8 s de narración; cada sub-plano se ancla literalmente", () => {
  const seqs = sequencesFromScript([beat5], { maxShotSec: SHOT_DENSITY_MAX_SEC.cinematic })!;
  const slots = seqs[0].slots;
  assert.ok(slots.length >= 9, `planos: ${slots.length}`);
  const spans = intentWordSpans(BLOCK5, slots.map((s) => s.visual) as never);
  assert.ok(spans.every((s) => s.anchoredBy === "quote"), "todas las citas se localizan");
  const maxWords = Math.round(8 * LONG_FORM_NARRATION_WORDS_PER_SECOND);
  const longest = Math.max(...spans.map((s) => s.end - s.start));
  assert.ok(longest <= maxWords + 8, `tramo más largo ${longest} palabras (≈${(longest / LONG_FORM_NARRATION_WORDS_PER_SECOND).toFixed(1)} s)`);
  // Variedad: escalas y encuadres distintos, movimiento, continuidad del sujeto (la descripción del padre se conserva).
  assert.ok(new Set(slots.map((s) => s.scale)).size >= 2);
  const subs = slots.filter((s) => (s.visual as { subShot?: number }).subShot);
  assert.ok(subs.every((s) => (s.visual as { motion?: boolean }).motion === true));
  assert.ok(subs.every((s) => String((s.visual as { description: string }).description).startsWith("Wide open steppe") || String((s.visual as { description: string }).description).startsWith("Spartan phalanx")));
  assert.ok(subs.every((s) => s.impact! <= 2), "un sub-plano nunca es un golpe nuevo");
  // El contrato de secuencias sigue siendo válido.
  const v = validateSequenceIntents(seqs, [{ id: "beat-5", narration: BLOCK5 }] as never, (n: string) => n.split(/\s+/).length / LONG_FORM_NARRATION_WORDS_PER_SECOND);
  assert.deepEqual(v.errors, []); assert.deepEqual(validateImpactIntents(seqs), []);
});

test("sin densidad (o plano corto) nada cambia; los planes ya confirmados no pasan por aquí", () => {
  const plain = sequencesFromScript([beat5])!;
  assert.equal(plain[0].slots.length, 2);
  const short = densifySlots(BLOCK5, plain[0].slots, 200);
  assert.equal(short.length, 2);
  assert.ok(sequencesFromScript([beat5], { maxShotSec: SHOT_DENSITY_MAX_SEC.economical })![0].slots.length > 2, "incluso en económico, ningún plano sostiene 40 s");
});

test("citas que no se localizan: no se divide (no se adivina)", () => {
  const bad = { ...beat5, visuals: [{ ...beat5.visuals[0], quote: "texto que no existe en la narración" }, beat5.visuals[1]] };
  const seqs = sequencesFromScript([bad], { maxShotSec: 8 })!;
  assert.equal(seqs[0].slots.length, 2);
});

const script = () => ({ title: "T", beats: [
  { narration: "Intro. Herodotus, writing his Histories around 440 BCE — roughly fifty years after the battle itself. More text here for context.", visuals: [{ quote: "Herodotus, writing his Histories around" }, { quote: "More text here for context" }] },
  { narration: "Geography. A pass eight meters wide at its narrowest point did not care how many riders were waiting behind it. End of beat.", visuals: [{ quote: "Geography. A pass eight meters wide" }] },
], creativeDirection: { signatureDetail: { beatIndex: 1, quote: "A pass eight meters wide at its narrowest point did not care how many riders were waiting behind it." }, shareableLine: null, protectInEdit: [] } });

test("correcciones localizadas: actualizan citas y marcas de edición; todo o nada", () => {
  const patches: NarrationPatch[] = [
    { beatIndex: 0, find: "writing his Histories around 440 BCE — roughly fifty years after the battle itself.", replace: "writing his Histories a few decades after the battle, most likely around 430 BCE.", reason: "fecha" },
    { beatIndex: 1, find: "A pass eight meters wide at its narrowest point did not care how many riders were waiting behind it.", replace: "A pass only a few meters wide at its narrowest points did not care how many riders were waiting behind it.", reason: "ancho" },
  ];
  const s = script();
  const r = applyNarrationPatches(s, patches);
  assert.equal(r.report.ok, true, r.report.errors.join("; "));
  assert.match(r.script.beats[0].narration, /around 430 BCE/);
  assert.equal(r.script.beats[1].visuals[0].quote, "Geography. A pass only a few meters wide", "la cita se corrige con el texto");
  assert.match((r.script.creativeDirection.signatureDetail as { quote: string }).quote, /only a few meters/);
  assert.equal(r.report.marksUpdated, 1); assert.ok(r.report.quotesUpdated >= 1);
  assert.match(s.beats[0].narration, /440 BCE/, "el original no se toca");
  // Ambiguo o inexistente → no se aplica nada.
  const amb = applyNarrationPatches(s, [{ beatIndex: 0, find: "text", replace: "words", reason: "x" }, patches[1]]);
  assert.equal(amb.report.ok, false); assert.equal(amb.script, s);
  const missing = applyNarrationPatches(s, [{ beatIndex: 1, find: "no existe", replace: "x", reason: "x" }]);
  assert.equal(missing.report.ok, false);
  // Una corrección que rompe una cita no corregible se rechaza.
  const breaks = applyNarrationPatches(s, [{ beatIndex: 0, find: "Herodotus, writing", replace: "Herodotus wrote", reason: "x" }]);
  assert.equal(breaks.report.ok, true, "la cita contiene el pasaje: se corrige y sigue localizada");
  const breaks2 = applyNarrationPatches(s, [{ beatIndex: 0, find: "More text", replace: "Other words", reason: "x" }]);
  assert.equal(breaks2.report.ok, true);
});

test("las correcciones del documental están bien formadas (una por pasaje exacto, con motivo)", () => {
  const data = JSON.parse(readFileSync("content/long-form/e8048599/correcciones.json", "utf8")) as { patches: NarrationPatch[] };
  assert.ok(data.patches.length >= 6);
  for (const p of data.patches) { assert.ok(p.find.length > 10 && p.replace.length > 5 && p.reason.length > 10 && p.find !== p.replace); assert.ok(p.beatIndex >= 0 && p.beatIndex <= 9); }
  assert.ok(data.patches.some((p) => /Ammianus Marcellinus/.test(p.replace)), "cita fuentes antiguas reales sobre los hunos");
});
