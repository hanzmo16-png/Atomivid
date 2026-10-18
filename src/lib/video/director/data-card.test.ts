/**
 * T42 — second pilot failure reproduced and closed: a Reel sentence with a figure ("el 90 por ciento…") is classed
 * `measurable_data`; planned illustrative stock is only "allowed with review", the bridge turns that review into a
 * blocker and the attempt failed AFTER narration (production diagnostic 7c136bbd, scene-0-s1). ROJO = the same plan
 * with stock only still blocks (the policy is respected, never loosened); VERDE = the deterministic data card renders
 * the figure as written and the plan passes; the preflight stops unsolvable sentences BEFORE any spend; the visible
 * message carries no code that the sanitiser would turn into «[configuración interna]».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { GeneratedScript } from "@/lib/providers/types";
import { scrubInternalNames } from "@/lib/video/customer-error";
import { DATA_CARD_HEIGHT, DATA_CARD_RECIPE_ID, DATA_CARD_WIDTH, dataCardAsset, dataCardSvg, directorReelPreflight, DirectorPreflightBlockedError, extractFigure, preflightBlockMessage, withDataCards } from "./data-card";
import { inputFromReel } from "./from-reel";
import { inspectReel } from "./reel-inspection";
import { directReel, directorBlockMessage, type ResolvedBeat } from "./reel-render";
import { simulateStoryboard } from "../storyboard/simulate";

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, "../../../..", p), "utf8");

/** The owner's second pilot, in shape: Spanish Reel, figures in two sentences. */
const PILOT: GeneratedScript = { title: "Por qué recordamos mejor las historias que los datos", segments: [
  { text: "Olvidamos el 90 por ciento de las cifras que escuchamos en una semana.", visualQuery: "person forgetting numbers", visualConcepts: ["person forgetting a number", "blank notebook"] },
  { text: "Pero una historia bien contada se queda con nosotros durante años.", visualQuery: "grandmother telling story", visualConcepts: ["grandmother telling a story", "family listening"] },
  { text: "Un estudio encontró que los relatos se recuerdan 22 veces más que los datos sueltos.", visualQuery: "university campus", visualConcepts: ["university campus", "students studying"] },
  { text: "Por eso las marcas cuentan historias en vez de listar números.", visualQuery: "shop window", visualConcepts: ["shop window", "brand poster"] },
] };
const PLAIN: GeneratedScript = { title: "Historias", segments: [
  { text: "Una historia bien contada se queda con nosotros.", visualQuery: "grandmother telling story", visualConcepts: ["grandmother telling a story"] },
  { text: "Por eso las marcas cuentan historias.", visualQuery: "shop window", visualConcepts: ["shop window"] },
] };

const timings = (script: GeneratedScript) => {
  let t = 0;
  return script.segments.map((s) => { const len = Math.max(2, s.text.split(/\s+/).length / 2.8); const r = { start: t, end: t + len }; t += len; return r; });
};
const stockBeats = (script: GeneratedScript, times: { start: number; end: number }[], cardScenes: number[] = []): ResolvedBeat[][] =>
  script.segments.map((_, i) => [{ start: times[i].start, end: times[i].end, url: `https://fixture.local/scene-${i}.svg`, mediaType: "image", source: cardScenes.includes(i) ? "data_card" : "stock", license: "CLEARED" }]);

test("figures are taken exactly as written: percent, times, quantities with unit, years, bare numbers; none when absent", () => {
  assert.deepEqual(extractFigure("Olvidamos el 90 por ciento de las cifras."), { kind: "percent", display: "90 %" });
  assert.deepEqual(extractFigure("Se recuerdan 22 veces más."), { kind: "times", display: "22 veces" });
  assert.deepEqual(extractFigure("Casi 3,5 millones de personas lo vieron."), { kind: "quantity", display: "3,5 millones" });
  assert.deepEqual(extractFigure("Todo empezó en 1998 en un garaje."), { kind: "year", display: "1998" });
  assert.deepEqual(extractFigure("Los 3 amigos volvieron."), { kind: "number", display: "3" });
  assert.equal(extractFigure("Una historia bien contada se queda con nosotros."), null);
});

test("the card is deterministic, 9:16, escapes the sentence and shows the figure as written", () => {
  const a = dataCardSvg({ text: "Olvidamos el 90 por ciento <de> las \"cifras\" & más", figure: { kind: "percent", display: "90 %" } });
  const b = dataCardSvg({ text: "Olvidamos el 90 por ciento <de> las \"cifras\" & más", figure: { kind: "percent", display: "90 %" } });
  assert.equal(a, b, "same input, byte-identical SVG");
  assert.match(a, new RegExp(`width="${DATA_CARD_WIDTH}" height="${DATA_CARD_HEIGHT}"`));
  assert.match(a, />90 %</);
  assert.match(a, /&lt;de&gt;/);
  assert.match(a, /&quot;cifras&quot;/);
  assert.doesNotMatch(a, /<de>|<script|https?:\/\/(?!www\.w3\.org\/2000\/svg")/);
  assert.match(a, /Dato tal como aparece en el guion/);
  const noFigure = dataCardSvg({ text: "Sin cifra", figure: null });
  assert.doesNotMatch(noFigure, /font-size="(240|170|120)"/);
  assert.match(noFigure, /Sin cifra/);
});

test("ROJO (pilot reproduced): with illustrative stock only, the Director still refuses the sentence with the figure — after narration, as a bridge blocker", () => {
  const times = timings(PILOT);
  const r = directReel({ script: PILOT, sceneTimings: times, beatsBySegment: stockBeats(PILOT, times), audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: times.at(-1)!.end + 0.4 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  const review = r.blockers.filter((b) => b.code === "AUDIT_POLICY_REVIEW");
  assert.ok(review.length >= 1, JSON.stringify(r.blockers));
  assert.equal(review[0].shotId, "scene-0-s1", "the first shot carries the 90 % sentence, exactly like the production attempt");
  assert.match(review[0].detail, /el dato medible debe verse en un gráfico o tarjeta/);
  // The policy itself is untouched: nothing in this module loosens it.
  assert.ok(r.blockers.every((b) => b.code.startsWith("AUDIT_")), "only editorial audit blockers; no timing/material defects in the fixture");
});

test("VERDE: with a deterministic data card for the measurable scenes the same Reel is montable; the card shot uses the data-card recipe and carries no review", () => {
  const times = timings(PILOT);
  const pre = directorReelPreflight(PILOT);
  assert.deepEqual(pre.cards.map((c) => c.sceneIndex), [0, 2]);
  assert.deepEqual(pre.cards.map((c) => c.figure?.display), ["90 %", "22 veces"]);
  assert.equal(pre.blockers.length, 0);
  const r = directReel({ script: PILOT, sceneTimings: times, beatsBySegment: stockBeats(PILOT, times, [0, 2]), audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: times.at(-1)!.end + 0.4 });
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.blockers));
  if (!r.ok) return;
  const cardShots = r.plan.shots.filter((s) => s.segmentId === "scene-0" || s.segmentId === "scene-2");
  assert.ok(cardShots.length >= 2);
  for (const s of cardShots) {
    assert.equal(s.recipeId, DATA_CARD_RECIPE_ID);
    assert.equal(s.asset.provenance, "data_graphic");
    assert.equal(s.asset.label, null, "a deterministic card carries no «ilustrativa» label");
    assert.equal(s.policy.status, "ok", "no review pending on a card");
    assert.ok(!s.uncertainty.some((u) => /solo acompaña/.test(u)));
  }
  const applied = r.applied.filter((a) => a.recipeId === DATA_CARD_RECIPE_ID);
  assert.ok(applied.every((a) => a.applied.motion === "static"), "a card stays legible: no zoom, no pan");
  assert.ok(r.plan.shots.filter((s) => s.segmentId === "scene-1").every((s) => s.asset.provenance === "stock_illustrative"), "scenes without figures keep their stock");
  assert.equal(r.plan.estimatedMaxUsd, 0);
});

test("the card asset is a planned deterministic graphic of its own segment (window 0..1, CLEARED, diagram) so only the data-card recipe dresses it", () => {
  const a = dataCardAsset({ id: "scene-0", text: PILOT.segments[0].text });
  assert.equal(a.provenance, "data_graphic");
  assert.equal(a.kind, "graphic");
  assert.equal(a.license, "CLEARED");
  assert.equal(a.content?.visualType, "diagram");
  assert.deepEqual(a.content?.window, { segmentId: "scene-0", from: 0, to: 1 });
  assert.ok(a.tags.includes("segment:scene-0"));
  assert.match(a.content?.visualIntent ?? "", /90 %/);
  assert.equal(a.content?.description, PILOT.segments[0].text);
});

test("preflight: no figures → no cards and no blockers; a negated or hedged figure is a hypothesis, not a datum (no card); human remains and specific evidence stop BEFORE spend with the sentence to change", () => {
  assert.deepEqual(directorReelPreflight(PLAIN), { cards: [], blockers: [] });
  const negated: GeneratedScript = { title: "x", segments: [{ text: "No fue el 90 por ciento, nunca se confirmó esa cifra.", visualQuery: "a", visualConcepts: ["a"] }] };
  assert.deepEqual(directorReelPreflight(negated).cards, []);
  const remains: GeneratedScript = { title: "x", segments: [
    { text: "Una historia bien contada se queda con nosotros.", visualQuery: "a", visualConcepts: ["grandmother telling a story"] },
    { text: "Encontraron restos humanos bajo el templo y nadie lo contó.", visualQuery: "b", visualConcepts: ["old temple"] },
  ] };
  const pre = directorReelPreflight(remains);
  assert.equal(pre.blockers.length, 1);
  assert.equal(pre.blockers[0].sceneIndex, 1);
  assert.equal(pre.blockers[0].policyClass, "human_remains");
  assert.match(pre.blockers[0].hint, /restos humanos/);
  // Specific evidence (pillars, structures…) only becomes a policy class when the storyboard backs it with documentary
  // material; a Reel's simulated storyboard never does, so the lexicon alone is an alert and the sentence is not blocked.
  const evidence: GeneratedScript = { title: "x", segments: [{ text: "Los pilares de piedra sostienen el santuario.", visualQuery: "a", visualConcepts: ["stone pillars"] }] };
  assert.deepEqual(directorReelPreflight(evidence), { cards: [], blockers: [] });
  const err = new DirectorPreflightBlockedError(pre.blockers);
  assert.match(err.message, /escena 2/);
  assert.match(err.message, /antes de generar voz o gastar nada/);
  assert.match(err.message, /Edita el guion/);
  assert.equal(scrubInternalNames(err.message), err.message, "nothing the sanitiser would hide");
  assert.ok(preflightBlockMessage(pre.blockers).length <= 600);
});

test("the review page (inspectReel) plans the same cards: no POLICY_REVIEW on the figure sentences, cards listed", () => {
  const r = inspectReel(PILOT, { renderEnabled: true });
  assert.ok(r.status !== "error", "inspection must not error");
  if (!("dataCards" in r)) return;
  assert.deepEqual(r.dataCards, [{ segmentId: "scene-0", figure: "90 %" }, { segmentId: "scene-2", figure: "22 veces" }]);
  assert.deepEqual(r.preflightBlockers, []);
  assert.ok(!r.issues.some((i) => i.code === "POLICY_REVIEW" && /dato medible/.test(i.detail)), JSON.stringify(r.issues));
  assert.ok(r.shots.filter((s) => s.segmentId === "scene-0").every((s) => s.recipeId === DATA_CARD_RECIPE_ID));
  const raw = inputFromReel(simulateStoryboard(PILOT));
  const withCards = withDataCards(raw, directorReelPreflight(PILOT).cards);
  assert.equal(withCards.inventory.filter((a) => a.provenance === "data_graphic").length, 2);
  assert.equal(withCards.inventory.length, raw.inventory.length, "the card replaces the planned stock of its segment");
});

test("the stored Director message never contains a code the sanitiser would replace with «[configuración interna]»; editorial blocks say which sentence to rewrite", () => {
  const m = directorBlockMessage([{ code: "AUDIT_POLICY_REVIEW", shotId: "scene-0-s1", detail: "el dato medible debe verse en un gráfico o tarjeta; esta imagen solo acompaña" }, { code: "AUDIT_LICENSE_PENDING", shotId: "scene-1-s1", detail: "asset scene-1:planned licence NEEDS_REVIEW: pending" }]);
  assert.equal(scrubInternalNames(m), m, m);
  assert.doesNotMatch(m, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  assert.match(m, /revisión editorial pendiente/);
  assert.match(m, /plano scene-0-s1/);
  assert.match(m, /reformula esa frase/i);
  assert.match(m, /No se publicó ningún video con montaje clásico/);
  assert.ok(m.length <= 600);
  // Earlier categories keep their wording.
  assert.match(directorBlockMessage([{ code: "LICENSE_NOT_CLEARED_FOR_RENDER", shotId: "s1", detail: "licencia NOT_CLEARED" }]), /derechos o licencia/);
  assert.equal(scrubInternalNames(directorBlockMessage([{ code: "LICENSE_NOT_CLEARED_FOR_RENDER", shotId: "s1", detail: "licencia NOT_CLEARED" }])).includes("[configuración interna]"), false);
});

test("source guard: the worker and the render route run the preflight BEFORE any reservation, attempt or dispatch, and the worker reopens the script on a block", () => {
  const job = src("src/lib/video/run-job.ts");
  const pre = job.indexOf("directorReelPreflight(row.script_json"), reserve = job.indexOf("await reserveJobSupply(service, requestId");
  assert.ok(pre > 0 && reserve > pre, "preflight before reserveJobSupply in run-job.ts");
  assert.match(job, /error instanceof DirectorPreflightBlockedError\)/);
  const route = src("src/app/api/generate/[id]/render/route.ts");
  const rp = route.indexOf("directorReelPreflight(videoRequest.script_json"), sub = route.indexOf("assertCanGenerate(service, user.id"), res = route.indexOf("await reserveJobSupply(service, id");
  assert.ok(rp > 0 && sub > rp && res > rp, "preflight before the subscription check and the reservation in the render route");
  assert.match(route, /charge: "none_proven", status: videoRequest\.status, attempts: videoRequest\.render_attempts \};\n\s+return NextResponse\.json\(\{ error: preflightBlockMessage\(preflight\.blockers\), outcome \}, \{ status: 422 \}\)/);
});
