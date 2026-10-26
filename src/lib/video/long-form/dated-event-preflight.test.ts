import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarDatesIn, datedEventEvidenceBlockers, datedEventFindings, DATED_EVENT_EVIDENCE_REQUIRED, LongFormDatedEventEvidenceError } from "./dated-event-preflight";
import { LongFormVisualQualityError } from "./visual-report";
import { visualBlockMessage, visualCheck } from "./production-preflight";
import type { ProductionPlan } from "./production-plan";
import { shotsForSpan } from "./shots";
import { visualsForBeat } from "./visual-intents";

test("fechas de calendario (es/en/ISO) — día + mes", () => {
  assert.deepEqual(calendarDatesIn("La noche del 10 de mayo de 2024, millones de personas"), ["10 de mayo de 2024"]);
  assert.deepEqual(calendarDatesIn("El 20 de julio, Armstrong"), ["20 de julio"]);
  assert.deepEqual(calendarDatesIn("On May 10, 2024 the sky lit up"), ["may 10, 2024"]);
  assert.deepEqual(calendarDatesIn("On July 20th 1969"), ["july 20th 1969"]);
  assert.deepEqual(calendarDatesIn("the 10 May 2024 storm"), ["10 may 2024"]);
  assert.deepEqual(calendarDatesIn("fecha 2024-05-10"), ["2024-05-10"]);
});

test("sin fecha de calendario: años sueltos, mes sin día y el verbo inglés «may» no cuentan", () => {
  assert.deepEqual(calendarDatesIn("la primera de nivel G5 desde 2003"), []);
  assert.deepEqual(calendarDatesIn("en mayo de 2024 hubo auroras"), []);
  assert.deepEqual(calendarDatesIn("You may 3 times see it"), []);
  assert.deepEqual(calendarDatesIn("Todo empieza a unos ciento cincuenta millones de kilómetros"), []);
});

const dated = [
  { id: "b1", narration: "La noche del 10 de mayo de 2024, millones de personas miraron hacia arriba. Hubo reportes desde el sur.", visuals: [
    { description: "green aurora curtains moving over a small town at night", quote: "La noche del 10 de mayo de 2024" },
    { description: "green aurora above town rooftops at night", quote: "Hubo reportes desde el sur" },
  ] },
  { id: "b2", narration: "la primera de nivel G5 desde 2003.", visuals: [{ description: "diagram", quote: "la primera" }] },
];

// Fallo cerrado: escena sin cita en un pasaje fechado (su imagen se derivaría del pasaje).
const unquoted = [{ id: "b1", narration: "La noche del 10 de mayo de 2024, millones de personas miraron hacia arriba.", visuals: [{ description: "green aurora over town" }] }];

test("visual con cita literal en el pasaje fechado NO bloquea: la planificación v3 la convierte en tarjeta de texto", () => {
  assert.deepEqual(datedEventFindings(dated), []);
  assert.deepEqual(datedEventEvidenceBlockers(dated), []);
  const f = datedEventFindings(unquoted);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].visuals, ["green aurora over town"]);
  assert.match(datedEventEvidenceBlockers(unquoted)[0], new RegExp(`^${DATED_EVENT_EVIDENCE_REQUIRED}:`));
});

test("v3: la escena anclada al pasaje fechado se planifica como tarjeta de texto del pasaje; la de otro pasaje no", () => {
  const visuals = visualsForBeat(dated[0], "t", { identity: false });
  assert.deepEqual(visuals.map(v => Boolean(v.datedPassage)), [true, false]);
  const shots = shotsForSpan({ beatId: "b1", beatType: "hook", startSec: 0, endSec: 10, narration: dated[0].narration, strategy: "cinematic", visuals, anchoring: {}, targetCount: 2 });
  const datedShots = shots.filter(s => s.anchoredVisual?.datedPassage);
  assert.ok(datedShots.length >= 1);
  for (const s of datedShots) { assert.equal(s.type, "text"); assert.equal(s.source, "local"); }
  for (const s of shots.filter(s => !s.anchoredVisual?.datedPassage)) assert.notEqual(s.anchoredVisual?.quote, dated[0].visuals[0].quote);
  // v4 (identidad + pruebas verificadas) no cambia: su propio preflight decide.
  assert.ok(visualsForBeat(dated[0], "t", { identity: true }).every(v => v.datedPassage === undefined));
  // Sin fecha: nada cambia.
  assert.ok(visualsForBeat(dated[1], "t", { identity: false }).every(v => v.datedPassage === undefined));
});

test("fallo cerrado: visual sin quote o beat sin visuales en un pasaje fechado cuenta como anclada", () => {
  assert.equal(datedEventFindings([{ id: "a", narration: "El 4 de julio de 1776 se firmó.", visuals: [{ description: "flag" }] }]).length, 1);
  assert.equal(datedEventFindings([{ id: "a", narration: "El 4 de julio de 1776 se firmó." }]).length, 1);
});

test("el error es un LongFormVisualQualityError con IMPEDIMENTO DE ENTREGA y sin promesa de recursos gastados", () => {
  const err = new LongFormDatedEventEvidenceError(datedEventEvidenceBlockers(unquoted));
  assert.ok(err instanceof LongFormVisualQualityError);
  assert.equal(err.name, "LongFormDatedEventEvidenceError");
  assert.match(err.message, /^IMPEDIMENTO DE ENTREGA/);
  assert.match(err.message, /No se inició, reservó ni cobró nada/);
});

test("Configurar/arranque (visualCheck): v3 fechado sin cita no está listo; con cita anclada sí; v3 sin fecha y v1/v2 siguen como antes (sin E/S)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noIo = new Proxy({}, { get() { throw new Error("visualCheck v3 no debe tocar Supabase"); } }) as any;
  const v3 = { version: 3 } as ProductionPlan;
  const blocked = await visualCheck(noIo, { requestId: "r", plan: v3, beats: unquoted as never, topic: "t" });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.codes, [DATED_EVENT_EVIDENCE_REQUIRED]);
  assert.match(visualBlockMessage(blocked), /IMPEDIMENTO DE ENTREGA/);
  assert.equal((await visualCheck(noIo, { requestId: "r", plan: v3, beats: dated as never, topic: "t" })).ready, true);
  const undated = [{ id: "b1", narration: "Una noche de primavera, millones de personas miraron.", visuals: [] }];
  assert.deepEqual(await visualCheck(noIo, { requestId: "r", plan: v3, beats: undated as never, topic: "t" }), { applies: false, ready: true, codes: [], missingHeroIdentities: 0, missingHeroEvidence: 0, textCardRatio: null, maxTextCardRatio: 0.25, verifiedAssets: 0 });
  // Planes históricos v1/v2: sin cambios aunque el guion tenga fecha.
  assert.equal((await visualCheck(noIo, { requestId: "r", plan: { version: 2 } as ProductionPlan, beats: dated as never, topic: "t" })).ready, true);
});

test("«mar» en español (el mar) no es una fecha; «Mar. 5» y «Mar 5, 2024» sí", () => {
  assert.deepEqual(calendarDatesIn("En el mar 20 barcos se hundieron."), []);
  assert.deepEqual(calendarDatesIn("Navegaron por el mar 3 días."), []);
  assert.equal(calendarDatesIn("It happened on Mar. 5.").length, 1);
  assert.equal(calendarDatesIn("It happened on Mar 5, 2024.").length, 1);
  assert.equal(calendarDatesIn("It happened on 5 Mar 2024.").length, 1);
  assert.equal(calendarDatesIn("El 10 de mayo de 2024 cayó la red.").length, 1);
});
