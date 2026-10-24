/** Recuperación cinematográfica (e8048599): densidad de planos y correcciones localizadas. Puras, USD 0. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { densifySlots, sequencesFromScript, SHOT_DENSITY_MAX_SEC } from "./script-sequences";
import { intentWordSpans } from "./scene-anchoring";
import { validateSequenceIntents, validateImpactIntents } from "./sequence-intent";
import { applyNarrationPatches, type NarrationPatch } from "./narration-patch";
import { LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";
import { requiresSchematic } from "./cinematic-director";

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
  assert.ok(subs.every((s) => (s.visual as { motion?: boolean }).motion === true), "the parents declare physical action: continuations inherit it");
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

test("anclas incompletas: reparto por orden — se añaden continuaciones SIN cita (no se finge un ancla)", () => {
  const bad = { ...beat5, visuals: [{ ...beat5.visuals[0], quote: "texto que no existe en la narración" }, beat5.visuals[1]] };
  const seqs = sequencesFromScript([bad], { maxShotSec: 8 })!;
  const slots = seqs[0].slots;
  assert.ok(slots.length >= 10, `planos ${slots.length}`);
  const subs = slots.filter((s) => (s.visual as { subShot?: number }).subShot);
  assert.ok(subs.length > 0 && subs.every((s) => (s.visual as { quote?: string }).quote === undefined));
  const v = validateSequenceIntents(seqs, [{ id: "beat-5", narration: BLOCK5 }] as never);
  assert.deepEqual(v.errors, []);
});

test("clips generativos solo donde aportan: impacto 3 + movimiento en CONTEXT/ATMOSPHERE; nunca sub-planos ni pruebas", async () => {
  const { markAiVideoCandidates } = await import("./script-sequences");
  const { sequenceShotsForSpan } = await import("./sequence-direction");
  const beat = { ...beat5, visuals: [{ ...beat5.visuals[0], impact: 3 }, { ...beat5.visuals[1], beatClass: "EVIDENCE", evidence: { sourceIds: ["s1"] }, impact: 3 }] };
  const plain = sequencesFromScript([beat])!;
  const marked = markAiVideoCandidates(plain);
  const flags = marked[0].slots.map((s) => !!s.aiVideoCandidate);
  assert.deepEqual(flags.slice(0, 1), [true], "paisaje de impacto 3 con movimiento → candidato");
  assert.ok(marked[0].slots.filter((s) => s.role === "EVIDENCE").every((s) => !s.aiVideoCandidate), "una prueba nunca es un clip generativo");
  const { resolveSequences, PLAN_ESTIMATE_AVAILABILITY } = await import("./sequence-intent");
  const shots = sequenceShotsForSpan({ beatId: "beat-5", startSec: 0, endSec: 85, narration: BLOCK5, sequences: resolveSequences(marked, PLAN_ESTIMATE_AVAILABILITY) });
  assert.ok(shots.some((s) => s.type === "ai_video"));
  // Sin la marca (planes ya confirmados): ningún ai_video, idéntico a antes.
  const before = sequenceShotsForSpan({ beatId: "beat-5", startSec: 0, endSec: 85, narration: BLOCK5, sequences: resolveSequences(plain, PLAN_ESTIMATE_AVAILABILITY) });
  assert.ok(before.every((s) => s.type !== "ai_video"));
  // La densidad nunca marca sub-planos.
  const dense = sequencesFromScript([beat], { maxShotSec: 8, aiVideoCandidates: true })!;
  assert.ok(dense[0].slots.filter((s) => (s.visual as { subShot?: number }).subShot).every((s) => !s.aiVideoCandidate));
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
  assert.equal(r.script.beats[1].visuals[0].quote, "Geography. A pass only a few", "una cita que se solapa en parte se re-extrae del texto corregido");
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

test("elegibilidad de clip: acción militar/ecuestre declarada en movimiento sí; paisaje, mapa o persona señalando no", async () => {
  const { scoreAiVideoEligibility, AI_VIDEO_SCORE_THRESHOLD } = await import("./ai-video-eligibility");
  const score = (visualIntent: string, motionRequired = true) => scoreAiVideoEligibility({ id: "s", visualIntent, durationSec: 8, type: "ai_video", motionRequired }).eligibilityScore;
  assert.ok(score("Hun horsemen charge across open steppe at full gallop, dust rising") >= AI_VIDEO_SCORE_THRESHOLD);
  assert.ok(score("Greek defenders clashing with Persian soldiers in the narrow mountain pass") >= AI_VIDEO_SCORE_THRESHOLD);
  assert.ok(score("Horse stumbling and losing footing on rocky uneven narrow ground") >= AI_VIDEO_SCORE_THRESHOLD);
  assert.ok(score("A man pointing toward a hidden mountain trail at dusk") < AI_VIDEO_SCORE_THRESHOLD);
  assert.ok(score("Ancient map of the Thermopylae pass with cavalry charge arrows") < AI_VIDEO_SCORE_THRESHOLD, "un mapa nunca");
  assert.ok(score("Hun horsemen charge across the steppe", false) < AI_VIDEO_SCORE_THRESHOLD, "sin movimiento declarado no");
});

test("audit #199: a sub-shot inherits the parent's motion (camera work is not physical action) — no spurious schematic cards", () => {
  const still = { ...beat5, visuals: beat5.visuals.map((v) => ({ ...v, motion: false, era: "ancient" })) };
  const slots = sequencesFromScript([still], { maxShotSec: SHOT_DENSITY_MAX_SEC.cinematic })![0].slots;
  const subs = slots.filter((s) => (s.visual as { subShot?: number }).subShot);
  assert.ok(subs.length >= 7);
  assert.ok(subs.every((s) => (s.visual as { motion?: boolean }).motion === false), "a static ancient place stays static in every continuation");
  assert.equal(slots.filter((s) => requiresSchematic(s.visual as never)).length, 0, "no static ancient scene becomes a text card");
  // A parent that DOES declare physical action in an ancient era stays schematic, and so do its continuations (Director rule kept).
  const action = { ...beat5, visuals: beat5.visuals.map((v) => ({ ...v, motion: true, era: "ancient" })) };
  const aSlots = sequencesFromScript([action], { maxShotSec: SHOT_DENSITY_MAX_SEC.cinematic })![0].slots;
  assert.ok(aSlots.every((s) => requiresSchematic(s.visual as never)), "continuations never launder an ancient action into a photoreal image");
});

test("audit #199: a scene quote inside a corrected passage in the MIDDLE of a beat is re-extracted (word index ≠ character offset)", () => {
  const narration = "So when Attila's riders finally reach the wall, the old arithmetic returns. Numbers stop mattering in a pass. The 300 didn't defeat an army. They defeated open ground — and that's not a smaller story, it's a more honest one. What remains is the question of time.";
  const s = { beats: [{ narration, visuals: [
    { description: "riders at the wall", quote: "So when Attila's riders finally reach" },
    { description: "ground", quote: "They defeated open ground — and that's" },
    { description: "the 300", quote: "The 300 didn't defeat an army." },
    { description: "time", quote: "What remains is the question of time." },
  ] }] };
  const r = applyNarrationPatches(s, [{ beatIndex: 0, find: "The 300 didn't defeat an army. They defeated open ground — and that's not a smaller story, it's a more honest one.",
    replace: "The 300 didn't stop an army on their own. The narrow ground fought beside them — and that's not a smaller story, it's a more honest one.", reason: "x" }]);
  assert.equal(r.report.ok, true, r.report.errors.join("; "));
  const q = r.script.beats[0].visuals.map((v) => v.quote);
  assert.equal(q[0], "So when Attila's riders finally reach", "a quote before the passage is untouched");
  assert.equal(q[3], "What remains is the question of time.", "a quote after the passage is untouched");
  for (const x of q) assert.ok(r.script.beats[0].narration.includes(x!), `«${x}» still located`);
  assert.match(q[1]!, /^The 300 didn't stop/, "inside the passage → re-extracted from the start of the correction");
});
