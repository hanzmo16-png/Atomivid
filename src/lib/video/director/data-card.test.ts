/**
 * T42 — second pilot failure reproduced and closed: a Reel sentence with a figure ("el 90 por ciento…") is classed
 * `measurable_data`; planned illustrative stock is only "allowed with review", the bridge turns that review into a
 * blocker and the attempt failed AFTER narration (production diagnostic 7c136bbd, scene-0-s1). ROJO = the same plan
 * with stock only still blocks (the policy is respected, never loosened); VERDE = the deterministic data card renders
 * the figure as written and the plan passes; the preflight stops unsolvable sentences BEFORE any spend; the visible
 * message carries no code that the sanitiser would turn into «[configuración interna]».
 *
 * T44 (independent review of PR #137): a card per CLAIM on its own narration window (finding A), honest provenance on
 * the card and in the plan (finding B), lexicon without false positives (list counters, «una cifra», bare units).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { GeneratedScript } from "@/lib/providers/types";
import { scrubInternalNames } from "@/lib/video/customer-error";
import { cardAssetId, cardSegmentId, cardWindows, claimsOf, DATA_CARD_HEIGHT, DATA_CARD_PROVENANCE_TEXT, DATA_CARD_RECIPE_ID, DATA_CARD_WIDTH, dataCardAsset, dataCardSvg, directorReelPreflight, DirectorPreflightBlockedError, extractFigure, extractFigures, heroOf, MIN_CARD_SECONDS, MIN_CARD_TOKENS, NEUTRAL_CARD_TEXT, neutralCardAsset, neutralCardSvg, preflightBlockMessage, tokenSlice, withDataCards, type CardWindow, type DataCardPlan } from "./data-card";
import { inputFromReel } from "./from-reel";
import { topicsOf, unitPolicy } from "./policy";
import { DirectorInputSchema } from "./contract";
import { editorialReport } from "./report";
import { unitsFor } from "./propose";
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
/** T44 adversarial case from the independent review: two claims, two years, two percentages in ONE scene. */
const TWO_CLAIMS: GeneratedScript = { title: "Dos afirmaciones", segments: [
  { text: "En 2019, el 30 % recordó la historia; en 2020, el 70 % recordó el dato.", visualQuery: "people remembering", visualConcepts: ["people remembering"] },
  { text: "Por eso las marcas cuentan historias en vez de listar números.", visualQuery: "shop window", visualConcepts: ["shop window"] },
] };

const timings = (script: GeneratedScript) => {
  let t = 0;
  return script.segments.map((s) => { const len = Math.max(2, s.text.split(/\s+/).length / 2.8); const r = { start: t, end: t + len }; t += len; return r; });
};
const stockBeats = (script: GeneratedScript, times: { start: number; end: number }[], cardScenes: number[] = []): ResolvedBeat[][] =>
  script.segments.map((_, i) => [{ start: times[i].start, end: times[i].end, url: `https://fixture.local/scene-${i}.svg`, mediaType: "image", source: cardScenes.includes(i) ? "data_card" : "stock", license: "CLEARED" }]);
/** Beats exactly as generate-video.ts derives them from the preflight cards, on a uniform synthetic word clock. */
const cardBeats = (script: GeneratedScript, sceneIndex: number, wordSeconds: number, start: number): ResolvedBeat[] => {
  const cards = directorReelPreflight(script).cards.filter(c => c.sceneIndex === sceneIndex);
  return cards.map((c, k) => ({ url: `https://fixture.local/card-${sceneIndex}-${k}.svg`, mediaType: "image", source: "data_card", license: "CLEARED",
    start: start + c.fromToken * wordSeconds, end: start + c.toToken * wordSeconds, card: { text: c.text, windowText: c.windowText, figures: c.figures } }));
};

test("figures are taken exactly as written, in narration order: percent, times, quantities with unit, years, bare numbers; none when absent", () => {
  assert.deepEqual(extractFigure("Olvidamos el 90 por ciento de las cifras."), { kind: "percent", display: "90 %" });
  assert.deepEqual(extractFigure("Se recuerdan 22 veces más."), { kind: "times", display: "22 veces" });
  assert.deepEqual(extractFigure("Casi 3,5 millones de personas lo vieron."), { kind: "quantity", display: "3,5 millones" });
  assert.deepEqual(extractFigure("Todo empezó en 1998 en un garaje."), { kind: "year", display: "1998" });
  assert.deepEqual(extractFigure("Los 3 amigos volvieron."), { kind: "number", display: "3" });
  assert.equal(extractFigure("Una historia bien contada se queda con nosotros."), null);
  // T44: every figure, in the order it is narrated (a year before its percentage), never reordered by pattern priority.
  assert.deepEqual(extractFigures("En 2019, el 30 % recordó la historia.").map(f => f.display), ["2019", "30 %"]);
  assert.equal(heroOf(extractFigures("En 2019, el 30 % recordó la historia.")), "2019 · 30 %");
  assert.equal(heroOf([]), null);
});

test("claims: one per sentence; a sentence with two values is cut at its clauses (lead-ins join the next clause); two values in one clause are not representable", () => {
  const c = claimsOf("En 2019, el 30 % recordó la historia; en 2020, el 70 % recordó el dato.");
  assert.deepEqual(c.map(x => [x.text, x.figures.map(f => f.display), x.representable]), [
    ["En 2019, el 30 % recordó la historia;", ["2019", "30 %"], true],
    ["en 2020, el 70 % recordó el dato.", ["2020", "70 %"], true],
  ]);
  assert.deepEqual(c.map(x => [x.fromToken, x.toToken]), [[0, 8], [8, 16]]);
  const comma = claimsOf("Según el estudio, el 30 % recordó la historia, pero el 70 % recordó el dato.");
  assert.deepEqual(comma.map(x => [x.text, x.figures.map(f => f.display)]), [["Según el estudio, el 30 % recordó la historia,", ["30 %"]], ["pero el 70 % recordó el dato.", ["70 %"]]]);
  const packed = claimsOf("El 30 % recordó la historia y el 70 % recordó el dato.");
  assert.equal(packed.length, 1);
  assert.equal(packed[0].representable, false, "two values in one clause: one card cannot show each when it is said");
  // A year next to a value is context, not a second value.
  assert.ok(claimsOf("En 2019 el 30 % recordó la historia.").every(x => x.representable));
  assert.deepEqual(claimsOf("Sin cifras aquí.").map(x => x.figures), [[]]);
});

test("the card is deterministic, 9:16, escapes the sentence, shows the figures as written and says what it is (script datum, unverified)", () => {
  const a = dataCardSvg({ text: "Olvidamos el 90 por ciento <de> las \"cifras\" & más", figure: { kind: "percent", display: "90 %" } });
  const b = dataCardSvg({ text: "Olvidamos el 90 por ciento <de> las \"cifras\" & más", figure: { kind: "percent", display: "90 %" } });
  assert.equal(a, b, "same input, byte-identical SVG");
  assert.match(a, new RegExp(`width="${DATA_CARD_WIDTH}" height="${DATA_CARD_HEIGHT}"`));
  assert.match(a, />90 %</);
  assert.match(a, /&lt;de&gt;/);
  assert.match(a, /&quot;cifras&quot;/);
  assert.doesNotMatch(a, /<de>|<script|https?:\/\/(?!www\.w3\.org\/2000\/svg")/);
  assert.match(a, /DATO DEL GUION/);
  assert.ok(a.includes(DATA_CARD_PROVENANCE_TEXT) && /sin fuente verificada/.test(a), "the card never presents itself as verified evidence");
  const noFigure = dataCardSvg({ text: "Sin cifra", figure: null });
  assert.doesNotMatch(noFigure, /font-size="(240|170|120|84)"/);
  assert.match(noFigure, /Sin cifra/);
  // T44: the hero line carries the claim's figures in narration order.
  const two = dataCardSvg({ text: "En 2019, el 30 % recordó la historia;", figure: null, figures: extractFigures("En 2019, el 30 % recordó la historia;") });
  assert.match(two, />2019 · 30 %</);
});

test("SVG safety: a hostile sentence cannot inject markup, scripts, external references or event handlers", () => {
  const hostile = `<script>alert(1)</script><image href="https://evil.example/x.svg"/> onload="x()" url(https://evil.example) <![CDATA[x]]> </text><text>`;
  const svg = dataCardSvg({ text: hostile, figure: null });
  // Markup only (text-node contents removed): nothing hostile becomes an element, an attribute or a reference.
  const markup = svg.replace(/>[^<]*</g, "><");
  assert.doesNotMatch(markup, /<script|<image|<!\[CDATA|href=|url\(|onload=|<\/text><text>/);
  assert.doesNotMatch(markup, /https?:\/\/(?!www\.w3\.org\/2000\/svg")/, "no external reference survives");
  assert.deepEqual([...new Set(markup.match(/<\/?[a-z]+/g))].sort(), ["</svg", "</text", "<rect", "<svg", "<text"], "only the card's own elements exist");
  assert.equal((svg.match(/<text /g) ?? []).length, (svg.match(/<\/text>/g) ?? []).length, "every text element is the card's own");
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the hostile text is shown escaped, as text");
  assert.ok(!/<[^>]*\son[a-z]+=/i.test(svg), "no event-handler attribute anywhere");
});

test("lexicon (T44): a datum needs a quantity; «una cifra», a bare unit or a list counter is not measurable data; negation/hedge stay hypothesis", () => {
  const raw = inputFromReel(simulateStoryboard(PLAIN));
  const input = DirectorInputSchema.parse(raw);
  const cls = (text: string) => unitPolicy(input, input.segments[0], text).class;
  assert.ok(!topicsOf("¿Por qué olvidas una cifra en minutos?").includes("data"));
  assert.ok(!topicsOf("Estas son las 3 razones para contar historias.").includes("data"));
  assert.ok(!topicsOf("Los 5 errores que cometes al presentar.").includes("data"));
  assert.ok(!topicsOf("A pocos metros del lugar.").includes("data"));
  assert.ok(!topicsOf("Pesaba toneladas, decían.").includes("data"));
  assert.ok(topicsOf("Pesaba diez toneladas.").includes("data"));
  assert.ok(topicsOf("Uno de cada cinco lo recuerda.").includes("data"));
  assert.ok(topicsOf("Olvidamos el 90 por ciento de las cifras.").includes("data"));
  assert.ok(topicsOf("A 20 metros del lugar.").includes("data"));
  assert.ok(topicsOf("Tres razones y un 40 % de mejora.").includes("data"), "a real value next to a list counter still counts");
  assert.equal(cls("Estas son las 3 razones para contar historias."), "atmosphere");
  assert.equal(cls("Olvidamos el 90 por ciento de las cifras."), "measurable_data");
  assert.equal(cls("Todo empezó en 1998 en un garaje."), "measurable_data", "a year is a measurable datum (chrono)");
  assert.equal(cls("No fue el 90 por ciento, nunca se confirmó."), "hypothesis");
  assert.equal(cls("Quizás el 90 por ciento lo olvide."), "hypothesis");
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

test("VERDE: with a deterministic data card for the measurable scenes the same Reel is montable; the card shot uses the data-card recipe, carries no review and no evidence claim", () => {
  const times = timings(PILOT);
  const pre = directorReelPreflight(PILOT);
  assert.deepEqual(pre.cards.map((c) => c.sceneIndex), [0, 2]);
  assert.deepEqual(pre.cards.map((c) => c.figure?.display), ["90 %", "22 veces"]);
  assert.deepEqual(pre.cards.map((c) => [c.index, c.count, c.from, c.to]), [[0, 1, 0, 1], [0, 1, 0, 1]]);
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
    assert.match(s.visualTheme, /sin fuente verificada/, "the plan records the card as a script transcription, not evidence");
  }
  const applied = r.applied.filter((a) => a.recipeId === DATA_CARD_RECIPE_ID);
  assert.ok(applied.every((a) => a.applied.motion === "static"), "a card stays legible: no zoom, no pan");
  assert.ok(r.plan.shots.filter((s) => s.segmentId === "scene-1").every((s) => s.asset.provenance === "stock_illustrative"), "scenes without figures keep their stock");
  assert.equal(r.plan.estimatedMaxUsd, 0);
  assert.ok(r.input.inventory.filter(a => a.provenance === "data_graphic").every(a => (a.tags ?? []).includes("sin-fuente-verificada") && a.content?.bibleClass === "DETERMINISTIC"));
});

test("T44 finding A — ROJO/VERDE: two claims in one scene get two cards on their own narration windows; at the moment «70 %» is said the «30 %» card is gone", () => {
  const WORD = 0.42;
  const n0 = TWO_CLAIMS.segments[0].text.split(/\s+/).length, n1 = TWO_CLAIMS.segments[1].text.split(/\s+/).length;
  const times = [{ start: 0, end: n0 * WORD }, { start: n0 * WORD, end: (n0 + n1) * WORD }];
  const pre = directorReelPreflight(TWO_CLAIMS);
  assert.equal(pre.blockers.length, 0);
  assert.deepEqual(pre.cards.map(c => [c.index, c.count, c.fromToken, c.toToken, heroOf(c.figures)]), [[0, 2, 0, 8, "2019 · 30 %"], [1, 2, 8, 16, "2020 · 70 %"]]);
  assert.deepEqual(pre.cards.map(c => c.windowText), ["En 2019, el 30 % recordó la historia;", "en 2020, el 70 % recordó el dato."]);
  // ROJO shape (614b869): ONE card for the whole scene — the plan accepts it, but «30 %» is what is shown while «70 %» is said.
  const oneCard: ResolvedBeat[] = [{ url: "https://fixture.local/card-0.svg", mediaType: "image", source: "data_card", license: "CLEARED", start: times[0].start, end: times[0].end,
    card: { text: TWO_CLAIMS.segments[0].text, windowText: TWO_CLAIMS.segments[0].text, figures: extractFigures(TWO_CLAIMS.segments[0].text).slice(0, 2) } }];
  const stock1: ResolvedBeat[] = [{ url: "https://fixture.local/scene-1.svg", mediaType: "image", source: "stock", license: "CLEARED", start: times[1].start, end: times[1].end }];
  const t70 = TWO_CLAIMS.segments[0].text.split(/\s+/).indexOf("70") * WORD + WORD / 2;
  const activeIntent = (r: ReturnType<typeof directReel>) => {
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.blockers)); if (!r.ok) return "";
    const a = r.applied.find(x => x.applied.startSeconds <= t70 && t70 < x.applied.endSeconds)!;
    const shot = r.plan.shots.find(s => s.id === a.shotId)!;
    return r.input.inventory.find(x => x.id === shot.asset.assetId)?.content?.visualIntent ?? "";
  };
  const rojo = activeIntent(directReel({ script: TWO_CLAIMS, sceneTimings: times, beatsBySegment: [oneCard, stock1], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: times[1].end + 0.4 }));
  assert.match(rojo, /30 %/, "ROJO shape reproduced: the single card still carries 30 % while 70 % is narrated");
  // VERDE: the beats generate-video.ts now derives from the preflight (one per claim, cut at the next claim's first word).
  const verde = directReel({ script: TWO_CLAIMS, sceneTimings: times, beatsBySegment: [cardBeats(TWO_CLAIMS, 0, WORD, 0), stock1], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: times[1].end + 0.4 });
  const intent = activeIntent(verde);
  assert.match(intent, /2020 · 70 %/);
  assert.doesNotMatch(intent, /30 %/);
  assert.ok(verde.ok); if (!verde.ok) return;
  // Each card is its own Director segment: window, text and asset bound together; no card leaks into the other window.
  assert.deepEqual(verde.input.segments.map(s => [s.id, Math.round(s.start * 100) / 100, Math.round(s.end * 100) / 100]), [["scene-0#1", 0, 3.36], ["scene-0#2", 3.36, 6.72], ["scene-1", 6.72, Math.round(times[1].end * 100) / 100]]);
  for (const s of verde.plan.shots.filter(s => s.segmentId.startsWith("scene-0"))) {
    assert.equal(s.recipeId, DATA_CARD_RECIPE_ID);
    assert.equal(s.asset.assetId, cardAssetId("scene-0", s.segmentId.endsWith("#1") ? 0 : 1, 2));
    const intent = verde.input.inventory.find(x => x.id === s.asset.assetId)!.content!.visualIntent!;
    assert.ok(s.segmentId.endsWith("#1") ? /30 %/.test(intent) && !/70 %/.test(intent) : /70 %/.test(intent) && !/30 %/.test(intent), `${s.id}: ${intent}`);
  }
  assert.ok(verde.applied.filter(a => a.recipeId === DATA_CARD_RECIPE_ID).every(a => a.applied.motion === "static"));
  assert.equal(cardSegmentId("scene-0", 0, 1), "scene-0", "a scene with one card keeps its id");
});

test("T44: a clause that packs two values is refused BEFORE spend with the sentence to split; nothing is invented", () => {
  const packed: GeneratedScript = { title: "x", segments: [{ text: "El 30 % recordó la historia y el 70 % recordó el dato.", visualQuery: "a", visualConcepts: ["people"] }] };
  const pre = directorReelPreflight(packed);
  assert.deepEqual(pre.cards, []);
  assert.equal(pre.blockers.length, 1);
  assert.equal(pre.blockers[0].policyClass, "measurable_data");
  assert.match(pre.blockers[0].hint, /reparte las cifras en frases separadas/);
  const msg = preflightBlockMessage(pre.blockers);
  assert.match(msg, /escena 1/);
  assert.equal(scrubInternalNames(msg), msg);
});

test("the card asset is a planned deterministic graphic of its own segment (window 0..1, CLEARED, diagram) so only the data-card recipe dresses it; it declares itself unverified", () => {
  const a = dataCardAsset({ id: "scene-0", text: PILOT.segments[0].text });
  assert.equal(a.provenance, "data_graphic");
  assert.equal(a.kind, "graphic");
  assert.equal(a.license, "CLEARED");
  assert.equal(a.content?.visualType, "diagram");
  assert.deepEqual(a.content?.window, { segmentId: "scene-0", from: 0, to: 1 });
  assert.ok(a.tags.includes("segment:scene-0") && a.tags.includes("sin-fuente-verificada"));
  assert.match(a.content?.visualIntent ?? "", /90 %/);
  assert.match(a.content?.visualIntent ?? "", /sin fuente verificada: no acredita la cifra/);
  assert.equal(a.content?.description, PILOT.segments[0].text);
  assert.equal(a.content?.bibleClass, "DETERMINISTIC", "deterministic, never REAL_DOCUMENTARY");
});

test("preflight: no figures → no cards and no blockers; a negated or hedged figure is a hypothesis, not a datum (no card); human remains stop BEFORE spend with the sentence to change", () => {
  assert.deepEqual(directorReelPreflight(PLAIN), { cards: [], blockers: [] });
  const negated: GeneratedScript = { title: "x", segments: [{ text: "No fue el 90 por ciento, nunca se confirmó esa cifra.", visualQuery: "a", visualConcepts: ["a"] }] };
  assert.deepEqual(directorReelPreflight(negated).cards, []);
  const counter: GeneratedScript = { title: "x", segments: [{ text: "Estas son las 3 razones para contar historias.", visualQuery: "a", visualConcepts: ["a"] }] };
  assert.deepEqual(directorReelPreflight(counter), { cards: [], blockers: [] }, "a list counter gets no card (T44 lexicon)");
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

test("the review page (inspectReel) plans the same cards, split per claim: no POLICY_REVIEW on the figure sentences, cards listed", () => {
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
  // T44: two claims → two sub-segments with proportional windows before any voice exists, same ids as the render.
  const two = inspectReel(TWO_CLAIMS, { renderEnabled: true });
  assert.ok(two.status !== "error");
  if (!("dataCards" in two)) return;
  assert.deepEqual(two.dataCards, [{ segmentId: "scene-0", figure: "2019 · 30 %" }, { segmentId: "scene-0", figure: "2020 · 70 %" }]);
  assert.deepEqual([...new Set(two.shots.map(s => s.segmentId))], ["scene-0#1", "scene-0#2", "scene-1"]);
  // The only issue left is the planned stock of scene 1 whose licence is unknown before a clip is chosen (always pending here).
  assert.ok(two.issues.every(i => i.code === "LICENSE_PENDING" && i.shotId?.startsWith("scene-1")), JSON.stringify(two.issues));
  assert.ok(two.shots.filter(s => s.segmentId.startsWith("scene-0")).every(s => s.recipeId === DATA_CARD_RECIPE_ID && s.decision !== "pending"));
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

/**
 * T44 correction 1 (independent audit of 554a0fb): the former <250 ms window merge in generate-video.ts discarded a
 * card's identity and stretched its neighbour over another claim. ROJO reproduces that merge on real-shaped word
 * timestamps; VERDE is `cardWindows`: at every instant the active card carries only the figures of the claim narrated.
 */
const THREE_CLAIMS = "En 2019, el 30 % recordó la historia; el 70 % también; en 2021, el 50 % recordó el dato.";
const SHORT_FIRST = "El 70 % también; en 2019, el 30 % recordó la historia.";
/** Word starts: 0.4 s per word except the words of `shortTokens`, which last `shortSeconds` each (a fast provider). */
const wordClock = (n: number, shortTokens: number[], shortSeconds: number) => {
  const starts: number[] = []; let t = 0;
  for (let k = 0; k < n; k++) { starts.push(t); t += shortTokens.includes(k) ? shortSeconds : 0.4; }
  return { starts, end: t };
};
/** The claim narrated at instant t: the card whose token span contains the word being said. */
const narratedCard = (cards: DataCardPlan[], starts: number[], t: number) => {
  let k = 0; while (k + 1 < starts.length && starts[k + 1] <= t) k++;
  return cards.find(c => c.fromToken <= k && k < c.toToken)!;
};
/** The merge that 554a0fb applied (reproduced verbatim for the ROJO side). */
const legacyMerge = (windows: CardWindow[]): CardWindow[] => {
  const merged: CardWindow[] = [];
  for (const w of windows) { const prev = merged[merged.length - 1]; if (prev && w.end - w.start < 0.25) prev.end = w.end; else merged.push({ ...w }); }
  if (merged.length > 1 && merged[0].end - merged[0].start < 0.25) { merged[1].start = merged[0].start; merged.shift(); }
  return merged;
};
const activeAt = (windows: CardWindow[], t: number) => windows.find(w => w.start <= t && t < w.end)!;
const figuresOf = (c: DataCardPlan) => c.figures.map(f => f.display).join(" · ");
/** What is on screen at t: the figures of the active card, or «neutral» when the window shows the figure-less slate. */
const shownAt = (windows: CardWindow[], t: number) => { const w = activeAt(windows, t); return w.treatment === "neutral" ? "neutral" : figuresOf(w.card); };
/** Beats exactly as generate-video.ts derives them from the windows of a scene (neutral windows carry no figure). */
const beatsOf = (text: string, windows: CardWindow[]): ResolvedBeat[] => windows.map((w, k) => ({
  url: `https://fixture.local/card-0-${k}.svg`, mediaType: "image", source: "data_card", license: "CLEARED", start: w.start, end: w.end,
  card: w.treatment === "neutral" ? { text: "", windowText: tokenSlice(text, w.fromToken, w.toToken), figures: [], treatment: "neutral", neutralReason: w.neutralReason }
    : { text: w.card.text, windowText: tokenSlice(text, w.fromToken, w.toToken), figures: w.card.figures, treatment: "card" } }));
/** The visual intent of the asset the Director applied at instant t. */
const intentAt = (r: ReturnType<typeof directReel>, t: number) => {
  if (!r.ok) return "";
  const shot = r.applied.find(a => a.applied.startSeconds <= t && t < a.applied.endSeconds)!;
  return r.input.inventory.find(x => x.id === r.plan.shots.find(s => s.id === shot.shotId)!.asset.assetId)!.content!.visualIntent!;
};

for (const [name, text, shortTokens] of [["a later claim shorter than 250 ms", THREE_CLAIMS, [8, 9, 10, 11]], ["a first claim shorter than 250 ms", SHORT_FIRST, [0, 1, 2, 3]]] as const) {
  test(`T44 corrections 1+2 — ROJO/VERDE with word timestamps, ${name}: the merge showed a foreign card; cardWindows never does, and the short window is neutral (no figure) for exactly its time`, () => {
    const script: GeneratedScript = { title: "x", segments: [{ text, visualQuery: "people", visualConcepts: ["people"] }] };
    const pre = directorReelPreflight(script);
    assert.equal(pre.blockers.length, 0, JSON.stringify(pre.blockers));
    const cards = pre.cards;
    const n = cards[0].tokenCount;
    const { starts, end } = wordClock(n, [...shortTokens], 0.05);
    const verde = cardWindows(cards, 0, end, starts);
    const shortCard = cards.find(c => c.fromToken === shortTokens[0])!;
    const shortWindow = verde.find(w => w.card === shortCard)!;
    assert.ok(shortWindow.end - shortWindow.start < MIN_CARD_SECONDS, `the short claim really narrates in ${(shortWindow.end - shortWindow.start).toFixed(2)} s`);
    // ROJO: the former merge hides the short card under a neighbour, so while its claim is narrated another figure shows.
    const rojo = legacyMerge(verde);
    assert.ok(!rojo.some(w => w.card === shortCard), "ROJO: the merge discarded the short card's identity");
    const mid = (shortWindow.start + shortWindow.end) / 2;
    assert.notEqual(figuresOf(activeAt(rojo, mid).card), figuresOf(shortCard), `ROJO: at ${mid.toFixed(2)} s the active card says «${figuresOf(activeAt(rojo, mid).card)}» while the narration says «${figuresOf(shortCard)}»`);
    // VERDE: every card keeps its identity and exactly its window; windows are contiguous and cover the scene.
    assert.deepEqual(verde.map(w => w.card.index), cards.map(c => c.index));
    assert.equal(verde[0].start, 0); assert.equal(verde[verde.length - 1].end, end);
    for (let i = 1; i < verde.length; i++) assert.equal(verde[i].start, verde[i - 1].end);
    assert.ok(verde.every(w => w.timing === "word_timestamps" && w.end > w.start));
    // Correction 2: the short window is NEUTRAL (criterion 2 of correction 1): no figure at all for exactly its time; the
    // long windows keep their cards. At every instant the screen shows the narrated claim's own figures or nothing.
    assert.equal(shortWindow.treatment, "neutral"); assert.equal(shortWindow.neutralReason, "short_window");
    assert.ok(verde.filter(w => w !== shortWindow).every(w => w.treatment === "card"));
    assert.deepEqual([shortWindow.fromToken, shortWindow.toToken], [shortCard.fromToken, shortCard.toToken]);
    for (let t = 0.005; t < end; t += 0.01) {
      const shown = shownAt(verde, t), said = narratedCard(cards, starts, t);
      assert.ok(shown === figuresOf(said) || (shown === "neutral" && said === shortCard), `at ${t.toFixed(3)} s the screen shows «${shown}» but the narration is at «${figuresOf(said)}»`);
    }
    // The real render path: the beats generate-video derives from these windows plan one Director segment per window;
    // the short window is dressed by the neutral slate (no figure of ANY claim), the others by their own card.
    const r = directReel({ script, sceneTimings: [{ start: 0, end }], beatsBySegment: [beatsOf(text, verde)], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: end + 0.4 });
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.blockers));
    if (!r.ok) return;
    const intent = intentAt(r, mid);
    assert.ok(/tarjeta neutral/.test(intent) && !cards.some(c => intent.includes(figuresOf(c))), `the Director dresses the short window with the neutral slate only: ${intent}`);
    for (const w of verde.filter(x => x.treatment === "card")) {
      const i = intentAt(r, (w.start + w.end) / 2);
      assert.ok(i.includes(figuresOf(w.card)) && !cards.filter(c => c !== w.card).some(c => i.includes(figuresOf(c))), `long window dressed by its own card: ${i}`);
    }
    const short = r.applied.find(a => a.applied.startSeconds <= mid && mid < a.applied.endSeconds)!;
    assert.equal(short.applied.motion, "static");
    assert.ok(Math.abs(short.applied.startSeconds - shortWindow.start) < 1e-6 && Math.abs(short.applied.endSeconds - shortWindow.end) < 1e-6, "the neutral slate lasts exactly the short window");
    // The Director itself refuses a NUMERIC card offered for that short window (another caller): fail-closed, never an
    // ordinary card of 0.2 s, never stretched (independent probe of GATE 2).
    const numeric = directReel({ script, sceneTimings: [{ start: 0, end }], beatsBySegment: [verde.map((w, k) => ({ url: `https://fixture.local/card-0-${k}.svg`, mediaType: "image" as const, source: "data_card" as const, license: "CLEARED" as const, start: w.start, end: w.end, card: { text: w.card.text, windowText: w.card.windowText, figures: w.card.figures } }))], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: end + 0.4 });
    assert.equal(numeric.ok, false);
    if (!numeric.ok) { assert.equal(numeric.blockers[0].code, "CARD_WINDOW_SHORT"); assert.match(numeric.blockers[0].detail, /tarjeta neutral/); assert.equal(scrubInternalNames(directorBlockMessage(numeric.blockers)).includes("[configuración interna]"), false); }
  });
}

/**
 * GATE 2, P1 (independent audit of 05e2d2b): a degenerate clock (the words of the middle claim all stamped at one
 * instant, still accepted by alignScenesToWords) made the WHOLE scene fall back to the proportional clock, so at 3.7 s
 * the «70 %» card was on screen while the clock narrates «2021,» (third claim). ROJO reproduces that fallback; VERDE:
 * every reliable boundary is kept, the ambiguous stretch is neutral, and the Director's real props show it.
 */
test("T44 correction 2 — ROJO/VERDE degenerate clock: reliable boundaries are kept, the ambiguous stretch is neutral, no card is redistributed or stretched", () => {
  const script: GeneratedScript = { title: "x", segments: [{ text: THREE_CLAIMS, visualQuery: "people", visualConcepts: ["people"] }] };
  const cards = directorReelPreflight(script).cards;
  const n = cards[0].tokenCount;
  const starts = Array.from({ length: n }, (_, k) => k < 12 ? Math.min(k, 8) * 0.4 : 3.2 + (k - 12) * 0.4);
  // ROJO: the proportional redistribution of 05e2d2b (reproduced verbatim) shows «70 %» at 3.7 s.
  const rojo = cards.map((c, k) => ({ card: c, start: (c.fromToken / n) * 6.4, end: ((k === cards.length - 1 ? n : cards[k + 1].fromToken) / n) * 6.4 }));
  const said37 = narratedCard(cards, starts, 3.7);
  assert.equal(figuresOf(said37), "2021 · 50 %");
  assert.equal(figuresOf(rojo.find(w => w.start <= 3.7 && 3.7 < w.end)!.card), "70 %", "ROJO: the proportional fallback shows a foreign figure");
  // VERDE
  const w = cardWindows(cards, 0, 6.4, starts);
  assert.deepEqual(w.map(x => [x.treatment, x.neutralReason ?? null, x.ambiguousBetween ?? null, Math.round(x.start * 100) / 100, Math.round(x.end * 100) / 100, x.fromToken, x.toToken]), [
    ["card", null, null, 0, 3.2, 0, 8],
    ["neutral", "ambiguous_clock", [1, 2], 3.2, 3.6, 8, 13],
    ["card", null, null, 3.6, 6.4, 13, 20],
  ]);
  assert.ok(w.every(x => x.timing === "word_timestamps"));
  assert.equal(tokenSlice(THREE_CLAIMS, 8, 13), "el 70 % también; en");
  // At no instant does the screen show a figure of a claim other than the one the clock narrates; the ambiguous stretch
  // (tokens of claims 2 and 3 stamped together) shows nothing numeric.
  for (let t = 0.005; t < 6.4; t += 0.01) {
    const shown = shownAt(w, t), said = narratedCard(cards, starts, t);
    assert.ok(shown === figuresOf(said) || shown === "neutral", `at ${t.toFixed(2)} s: «${shown}» vs narrated «${figuresOf(said)}»`);
  }
  assert.equal(shownAt(w, 3.7), "2021 · 50 %"); assert.equal(shownAt(w, 3.3), "neutral"); assert.equal(shownAt(w, 3.1), "2019 · 30 %");
  // The Director's real props: accepted, the neutral slate between 3.2 and 3.6, «2021 · 50 %» from 3.6.
  const r = directReel({ script, sceneTimings: [{ start: 0, end: 6.4 }], beatsBySegment: [beatsOf(THREE_CLAIMS, w)], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: 6.8 });
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.blockers));
  if (!r.ok) return;
  const scene = (t: number) => r.props.scenes.find(s => s.startSeconds <= t && t < s.endSeconds)!;
  assert.match(scene(3.7).mediaUrl, /card-0-2\.svg/); assert.match(scene(3.3).mediaUrl, /card-0-1\.svg/); assert.match(scene(3.1).mediaUrl, /card-0-0\.svg/);
  assert.ok(/tarjeta neutral/.test(intentAt(r, 3.3)) && !cards.some(c => intentAt(r, 3.3).includes(figuresOf(c))));
  assert.ok(intentAt(r, 3.7).includes("2021 · 50 %") && !intentAt(r, 3.7).includes("70 %"));
  assert.ok(intentAt(r, 3.1).includes("2019 · 30 %"));
  assert.deepEqual(r.input.segments.filter(s => s.id.startsWith("scene-0")).map(s => [s.id, s.start, s.end, s.text]), [
    ["scene-0#1", 0, 3.2, "En 2019, el 30 % recordó la historia;"], ["scene-0#2", 3.2, 3.6, "el 70 % también; en"], ["scene-0#3", 3.6, 6.4, "2021, el 50 % recordó el dato."],
  ]);
  // A claim fully swallowed by the ambiguity never shows (it has no reliable window): that is the only honest outcome.
  assert.ok(!w.some(x => x.treatment === "card" && x.card.index === 1));
  // No clock at all → proportional, declared; a non-monotonic clock has no reliable boundary → proportional too.
  assert.equal(cardWindows(cards, 0, 6.4, null).every(x => x.timing === "estimated_proportional" && x.treatment === "card"), true, "no timestamps → proportional");
  assert.equal(cardWindows(cards, 0, 6.4, starts.map((s, k) => k === 10 ? 0.1 : s)).every(x => x.timing === "estimated_proportional"), true, "non-monotonic clock → proportional");
  assert.deepEqual(cardWindows([], 0, 1, null), []);
});

test("T44 correction 2 — the neutral slate is deterministic, shows no figure and no claim, says what it is; its asset matches no claim (never the support of a statement)", () => {
  const a = neutralCardSvg({ reason: "short_window" }), b = neutralCardSvg({ reason: "ambiguous_clock" });
  assert.equal(a, neutralCardSvg({ reason: "short_window" }));
  assert.notEqual(a, b);
  for (const svg of [a, b]) {
    assert.match(svg, new RegExp(`width="${DATA_CARD_WIDTH}" height="${DATA_CARD_HEIGHT}"`));
    assert.doesNotMatch(svg, /font-weight="700"/, "no hero figure");
    assert.doesNotMatch(svg, />[^<]*\d[^<]*</, "no digit in any text node (the only digits are SVG geometry)");
    assert.ok(svg.includes("Cifra no mostrada") && svg.includes("DATO DEL GUION") && svg.includes(NEUTRAL_CARD_TEXT));
    assert.doesNotMatch(svg, /<script|href=|url\(|on[a-z]+=/i);
  }
  assert.ok(a.includes("menos de un cuarto de segundo") && b.includes("no permite situar la cifra"));
  const asset = neutralCardAsset({ id: "scene-0#2", text: "el 70 % también; en" }, "scene-0#2:card", "ambiguous_clock");
  assert.equal(asset.provenance, "data_graphic"); assert.equal(asset.content?.bibleClass, "DETERMINISTIC"); assert.equal(asset.content?.visualType, "diagram");
  assert.ok(asset.tags.includes("neutral") && asset.tags.includes("sin-cifra") && !asset.tags.includes("sin-fuente-verificada"));
  assert.ok(!/\d/.test(asset.content!.visualIntent!) && !/\d/.test(asset.content!.description!), "intent and description carry no figure");
  assert.deepEqual(asset.content?.window, { segmentId: "scene-0#2", from: 0, to: 1 });
  // withDataCards dresses a neutral plan with the slate and a card plan with its card.
  const script: GeneratedScript = { title: "x", segments: [{ text: THREE_CLAIMS, visualQuery: "people", visualConcepts: ["people"] }] };
  const cards = directorReelPreflight(script).cards;
  const plans: DataCardPlan[] = cards.map((c, k) => k === 1 ? { ...c, treatment: "neutral", neutralReason: "ambiguous_clock", text: "", figures: [], figure: null } : c);
  const input = withDataCards(inputFromReel(simulateStoryboard(script)), plans);
  const inv = input.inventory.filter(x => x.id.startsWith("scene-0#"));
  assert.deepEqual(inv.map(x => [x.id, /tarjeta neutral/.test(x.content?.visualIntent ?? "")]), [["scene-0#1:card", false], ["scene-0#2:card", true], ["scene-0#3:card", false]]);
});

/**
 * Fase 3 audit (Codex, 13f40d9): card windows measured on the voice's word clock were reported in director.json as
 * `unit.timing = estimated_proportional` with «alineación temporal estimada (sin marcas de palabra)», because the
 * provenance cardWindows returns was dropped between generate-video and the plan. ROJO = beats without that provenance
 * (the 13f40d9 path) mislabel measured windows. VERDE = the provenance travels with the beat: measured windows say
 * `word_timestamps`, the proportional fallback keeps `estimated_proportional`, the ambiguous stretch stays ambiguous
 * (measured boundaries ≠ verified figure sync), and windows, props, cards and every other plan field are IDENTICAL.
 */
test("T44 F3 traceability — ROJO/VERDE unit.timing reports where card boundaries come from; windows, props and cards unchanged", () => {
  const withTiming = (text: string, windows: CardWindow[]): ResolvedBeat[] => beatsOf(text, windows).map((b, k) => ({ ...b, card: { ...b.card!, timing: windows[k].timing } }));
  const reliable = wordClock(20, [], 0);
  const short = wordClock(20, [8, 9, 10, 11], 0.05);
  const degenerate = Array.from({ length: 20 }, (_, k) => k < 12 ? Math.min(k, 8) * 0.4 : 3.2 + (k - 12) * 0.4);
  const cases = [
    { name: "reliable clock", starts: reliable.starts as number[] | null, end: reliable.end, timing: "word_timestamps", attribution: ["single_claim", "single_claim", "single_claim"] },
    { name: "short window", starts: short.starts as number[] | null, end: short.end, timing: "word_timestamps", attribution: ["single_claim", "short_window", "single_claim"] },
    { name: "degenerate clock", starts: degenerate as number[] | null, end: 6.4, timing: "word_timestamps", attribution: ["single_claim", "ambiguous_clock", "single_claim"] },
    { name: "no clock", starts: null, end: 6.4, timing: "estimated_proportional", attribution: ["single_claim", "single_claim", "single_claim"] },
  ] as const;
  const script: GeneratedScript = { title: "x", segments: [{ text: THREE_CLAIMS, visualQuery: "people", visualConcepts: ["people"] }, { text: "Por eso las marcas cuentan historias en vez de listar números.", visualQuery: "shop", visualConcepts: ["shop"] }] };
  const cards = directorReelPreflight(script).cards.filter(c => c.sceneIndex === 0);
  assert.equal(cards[0].tokenCount, 20);
  for (const c of cases) {
    const w = cardWindows(cards, 0, c.end, c.starts ? [...c.starts] : null);
    assert.ok(w.every(x => x.timing === c.timing), `${c.name}: cardWindows says ${c.timing}`);
    const run = (beats: ResolvedBeat[]) => directReel({ script, sceneTimings: [{ start: 0, end: c.end }, { start: c.end, end: c.end + 4 }], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: c.end + 4.4,
      beatsBySegment: [beats, [{ url: "https://fixture.local/scene-1.svg", mediaType: "image", source: "stock", license: "CLEARED", start: c.end, end: c.end + 4 }]] });
    const rojo = run(beatsOf(THREE_CLAIMS, w)), verde = run(withTiming(THREE_CLAIMS, w));
    assert.ok(rojo.ok && verde.ok, `${c.name}: ${JSON.stringify(!rojo.ok ? rojo.blockers : !verde.ok ? verde.blockers : "")}`);
    if (!rojo.ok || !verde.ok) return;
    const cardShots = (r: typeof verde) => r.plan.shots.filter(s => s.segmentId.startsWith("scene-0#"));
    // ROJO (13f40d9): every card shot claims an estimated, proportional alignment, whatever the voice's clock was.
    assert.ok(cardShots(rojo).every(s => s.unit.timing === "estimated_proportional" && s.uncertainty.some(u => u.includes("sin marcas de palabra")) && !s.unit.attribution), `${c.name}: ROJO reproduces the mislabel`);
    // VERDE: the label says where the boundaries come from; attribution is reported apart from it.
    assert.deepEqual(cardShots(verde).map(s => s.unit.timing), cardShots(verde).map(() => c.timing), `${c.name}: unit.timing`);
    assert.deepEqual(cardShots(verde).map(s => s.unit.attribution), [...c.attribution], `${c.name}: attribution`);
    for (const s of cardShots(verde)) {
      assert.equal(s.uncertainty.some(u => u.includes("sin marcas de palabra")), c.timing === "estimated_proportional", `${c.name}: «estimada» only when the split really is proportional`);
      if (s.unit.attribution === "ambiguous_clock") assert.ok(s.uncertainty.some(u => /no permiten atribuirla a una sola afirmación/.test(u) && /sin sincronía de cifra verificada/.test(u)), "the ambiguous stretch stays ambiguous");
      if (s.unit.attribution === "short_window") assert.ok(s.uncertainty.some(u => /menos de un cuarto de segundo/.test(u)));
    }
    // No per-word times are fabricated anywhere; the non-card scene keeps its own (proportional) label untouched.
    assert.ok(verde.input.segments.every(s => s.wordTimes === undefined));
    assert.deepEqual(verde.plan.shots.filter(s => s.segmentId === "scene-1").map(s => s.unit), rojo.plan.shots.filter(s => s.segmentId === "scene-1").map(s => s.unit));
    // Nothing else changes: same props (what Remotion renders), same applied windows, same segments, same cards and
    // assets, same plan except the traceability fields (unit.timing, unit.attribution, uncertainty).
    assert.deepEqual(verde.props, rojo.props, `${c.name}: identical render props`);
    assert.deepEqual(verde.applied, rojo.applied, `${c.name}: identical applied shots`);
    assert.deepEqual(verde.input.segments.map(s => [s.id, s.start, s.end, s.text]), rojo.input.segments.map(s => [s.id, s.start, s.end, s.text]));
    assert.deepEqual(verde.input.inventory, rojo.input.inventory);
    const core = (r: typeof verde) => r.plan.shots.map(({ unit, uncertainty, ...rest }) => ({ ...rest, unit: { boundary: unit.boundary, cutReason: unit.cutReason } }));
    assert.deepEqual(core(verde), core(rojo), `${c.name}: identical plan apart from traceability`);
    const report = editorialReport(verde.plan, DirectorInputSchema.parse(verde.input));
    assert.equal(report.totals.timing[c.timing], cardShots(verde).length + (c.timing === "estimated_proportional" ? 1 : 0));
    assert.deepEqual(report.totals.cardAttribution, c.attribution.reduce<Record<string, number>>((m, a) => ({ ...m, [a]: (m[a] ?? 0) + 1 }), {}));
  }
  // The worker carries cardWindows' provenance into every card beat (both treatments); nothing derives it elsewhere.
  const gen = src("src/lib/video/generate-video.ts");
  assert.equal(gen.match(/timing: w\.timing \}/g)?.length, 2);
});

test("T44 F3 traceability — a measured card window cut further by the plan keeps `estimated_proportional` on its proportional inner cuts; no cardTiming = no claim", () => {
  const text = "Primera frase larga con varias palabras para el corte. Segunda frase larga con varias palabras para el corte. Tercera frase larga con varias palabras para el corte.";
  const seg = { start: 0, end: 24, text };
  const measured = unitsFor({ ...seg, cardTiming: { boundaries: "word_timestamps" } }, 3, 8);
  assert.ok(measured.length > 1, "the window is cut by the plan");
  assert.ok(measured.every(u => u.timing === "estimated_proportional"), "an inner cut placed proportionally is never reported as measured");
  assert.deepEqual(measured.map(u => [u.start, u.end, u.text]), unitsFor(seg, 3, 8).map(u => [u.start, u.end, u.text]), "the cuts themselves do not depend on the label");
  assert.equal(unitsFor({ ...seg, end: 5, cardTiming: { boundaries: "word_timestamps" } }, 3, 8)[0].timing, "word_timestamps");
  assert.equal(unitsFor({ ...seg, end: 5 }, 3, 8)[0].timing, "estimated_proportional");
  assert.equal(unitsFor({ ...seg, end: 5, cardTiming: { boundaries: "estimated_proportional" } }, 3, 8)[0].timing, "estimated_proportional");
});

test("T44 correction 1 — a claim too short to own a card window is refused BEFORE spend with the sentence to extend (fail-closed, never stretched)", () => {
  const packed: GeneratedScript = { title: "x", segments: [{ text: "70 %. En 2019, el 30 % recordó la historia.", visualQuery: "people", visualConcepts: ["people"] }] };
  const pre = directorReelPreflight(packed);
  assert.deepEqual(pre.cards, []);
  assert.equal(pre.blockers.length, 1);
  assert.equal(pre.blockers[0].sentence, "70 %.");
  assert.match(pre.blockers[0].hint, new RegExp(`al menos ${MIN_CARD_TOKENS} palabras`));
  assert.match(pre.blockers[0].reason, /2 palabra/);
  assert.equal(scrubInternalNames(preflightBlockMessage(pre.blockers)), preflightBlockMessage(pre.blockers));
  // Exactly MIN_CARD_TOKENS words is enough (the window is its own); the review page shows the blocker the same way.
  const ok: GeneratedScript = { title: "x", segments: [{ text: "El 70 % también. En 2019, el 30 % recordó la historia.", visualQuery: "people", visualConcepts: ["people"] }] };
  assert.equal(directorReelPreflight(ok).blockers.length, 0);
  const inspected = inspectReel(packed, { renderEnabled: true });
  assert.ok("preflightBlockers" in inspected && inspected.preflightBlockers.length === 1);
});

test("source guard: the worker and the render route run the preflight BEFORE any reservation, attempt or dispatch; the worker reopens the script on a block; cards are placed on the voice's word timestamps", () => {
  const job = src("src/lib/video/run-job.ts");
  const pre = job.indexOf("directorReelPreflight(row.script_json"), reserve = job.indexOf("await reserveJobSupply(service, requestId");
  assert.ok(pre > 0 && reserve > pre, "preflight before reserveJobSupply in run-job.ts");
  assert.match(job, /error instanceof DirectorPreflightBlockedError\)/);
  const route = src("src/app/api/generate/[id]/render/route.ts");
  const rp = route.indexOf("directorReelPreflight(videoRequest.script_json"), sub = route.indexOf("assertCanGenerate(service, user.id"), res = route.indexOf("await reserveJobSupply(service, id");
  assert.ok(rp > 0 && sub > rp && res > rp, "preflight before the subscription check and the reservation in the render route");
  assert.match(route, /charge: "none_proven", status: videoRequest\.status, attempts: videoRequest\.render_attempts \};\n\s+return NextResponse\.json\(\{ error: preflightBlockMessage\(preflight\.blockers\), outcome \}, \{ status: 422 \}\)/);
  const gen = src("src/lib/video/generate-video.ts");
  assert.match(gen, /cardWindows\(cards, timing\.start, timing\.end, [^)]*sceneWords\.map\(\(w\) => w\.startSeconds\)/, "card windows come from the real word timestamps through cardWindows");
  assert.doesNotMatch(gen, /merged\[|prev\.end = w\.end|merged\.shift\(\)/, "correction 1: no window merge anywhere in the worker");
  assert.match(gen, /card-\$\{i\}-\$\{k\}\.svg/);
  // Correction 2: a neutral window gets the neutral slate (never a figure) and the beat says so; no proportional
  // redistribution and no second voice anywhere in the worker.
  assert.match(gen, /w\.treatment === "neutral"/); assert.match(gen, /neutralCardSvg\(\{ reason: w\.neutralReason/);
  assert.match(gen, /treatment: "neutral", neutralReason: w\.neutralReason/);
  assert.doesNotMatch(gen, /build\("estimated_proportional"\)/);
  // Every paid step of a render (real storyboard, voice, footage, images) lives inside generateVideoFromScript, which
  // run-job only calls AFTER its preflight and its reservation: a refused script never reaches any of them.
  const call = job.indexOf("await generateVideoFromScript(");
  assert.ok(call > reserve && reserve > pre, "run-job: preflight → reservation → generateVideoFromScript");
  const fnStart = gen.indexOf("export async function generateVideoFromScript(");
  assert.ok(fnStart > 0 && gen.indexOf("buildStoryboard(") > fnStart && gen.indexOf("synthesizeCounted(") > fnStart, "storyboard and voice calls are inside generateVideoFromScript");
});
