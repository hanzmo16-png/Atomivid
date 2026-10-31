import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessRelevance } from "./stock-selection";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";

/**
 * Incident 2026-10-28 («Un día en la sabana africana», request c14f1e): the 67 stock selections the worker accepted,
 * replayed against the lexical gate (the provider's own public descriptions; no network, no images). Reviewed by eye
 * against the frames: 8 showed another continent/biome (kangaroos in Australia, Argentina, Tibetan Plateau, India,
 * pronghorns, a foggy mountain pasture). They must now be rejected; the other 59 must still pass.
 */
globalThis.fetch = (async () => { throw new Error("sin red"); }) as typeof fetch;

type Row = { at: number; description: string; subject: string; place: string; candidate: string };
const rows = JSON.parse(readFileSync(new URL("./__fixtures__/incident-c14f1e-sabana-selections.json", import.meta.url), "utf8")) as Row[];
const scene = (r: Pick<Row, "description" | "subject" | "place">): BeatVisual =>
  normalizeDeclaredVisuals([{ motion: false, era: "2020s", beatClass: "PLACE", quote: "sabana", ...r }], { identity: true })[0];

const WRONG_BY_EYE = new Set([20, 43.4, 83.5, 170.8, 178.1, 189.2, 245.1, 256.4]);

test("incidente c14f1e: las 8 imágenes de otra región o bioma se rechazan y las 59 pertinentes siguen pasando", () => {
  assert.equal(rows.length, 67);
  const rejected: number[] = [], wrongKept: string[] = [], goodLost: string[] = [];
  for (const r of rows) {
    const a = assessRelevance(scene(r), r.candidate);
    const bad = a.relevance === "irrelevant" && a.conflicts.length > 0;
    if (bad) rejected.push(r.at);
    if (WRONG_BY_EYE.has(r.at) && !bad) wrongKept.push(`${r.at} ${r.candidate}`);
    if (!WRONG_BY_EYE.has(r.at) && a.relevance !== "keyword_match") goodLost.push(`${r.at} ${r.candidate} → ${JSON.stringify(a.conflicts)}`);
  }
  assert.deepEqual(wrongKept, [], "ajenas que siguen pasando");
  assert.deepEqual(goodLost, [], "pertinentes que ahora se pierden");
  assert.equal(rejected.length, 8);
});

const SAVANNA = { description: "Buffalo resting in the African savanna at midday", subject: "African buffalo", place: "African savanna" };
const cases: [string, Pick<Row, "description" | "subject" | "place">, string, RegExp | null][] = [
  ["canguros australianos", { ...SAVANNA, subject: "savanna landscape" }, "kangaroos hopping through australian grassland", /región/],
  ["búfalo de agua en la India", SAVANNA, "water buffalo soaking in muddy waters at Kawardha, India", /región/],
  ["búfalo de agua que el proveedor ubica en África", SAVANNA, "mud covered water buffalo in african savanna", null],
  ["el océano Índico no es la India", { description: "Waves on the coast of Kenya", subject: "coast", place: "Kenya" }, "waves on the kenyan coast of the indian ocean", null],
  ["pasto de montaña con niebla", { ...SAVANNA, subject: "wildlife and livestock" }, "cattle grazing in a foggy mountain pasture at dawn", /bioma/],
  ["nieve en un desierto", { description: "Dunes of the Sahara at noon", subject: "desert dunes", place: "Sahara" }, "snowy desert dunes in winter", /bioma/],
  ["zoológico en una escena salvaje", { ...SAVANNA, subject: "giraffes" }, "giraffes in a zoo enclosure", /cautiverio/],
  ["un documental sobre zoológicos sí acepta un zoológico", { description: "Visitors at the city zoo", subject: "giraffes", place: "zoo" }, "giraffes in a zoo enclosure", null],
  ["sin región declarada no se juzga la región", { description: "Antelope at dusk", subject: "antelope", place: "" }, "pronghorn antelope at dusk", null],
];
for (const [name, v, text, expect] of cases) {
  test(`coherencia de contexto — ${name}`, () => {
    const a = assessRelevance(scene(v), text);
    if (expect) assert.ok(a.conflicts.some((c) => expect.test(c)) && a.relevance === "irrelevant", JSON.stringify(a));
    else assert.ok(!a.conflicts.some((c) => /región|bioma|cautiverio/.test(c)), JSON.stringify(a));
  });
}
