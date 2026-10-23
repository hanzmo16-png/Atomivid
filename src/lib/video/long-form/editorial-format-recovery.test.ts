// Incident 23d86d0a (2026-10-23, EN, 15 min, alternate-history matchup): the opening-payoff check answered
// with every required field valid plus an EMPTY extra key `firstAnswer.evidence.explanation: ""`, and the
// strict contract made a correct paid answer a terminal failure. These tests reproduce the real response
// SHAPE (values anonymised: the real excerptId had the same `<revision>:b0:w<n>` form, the real explanation
// was 565 characters) and cover the variants required for long documentaries. No provider calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { editorialBlockers, type EditorialScript } from "./editorial";
import { openingEvidence, validateOrRepairOpeningReview } from "./editorial-opening-repair";
import { normalizeRecoverableFormat, validateDocumentaryValue, DocumentaryResponseError } from "./json-response";
import { applyVisualAnchorRepair } from "./visual-anchor-repair";

type Scenario = { name: string; beats: number; firstBeatWords: number; otherBeatWords: number; vocabulary: string[] };
const SCENARIOS: Scenario[] = [
  { name: "Spanish documentary, 5 minutes", beats: 5, firstBeatWords: 190, otherBeatWords: 150,
    vocabulary: ["el", "archivo", "fechado", "contradice", "la", "versión", "oficial", "del", "puerto"] },
  { name: "English documentary, 15 minutes", beats: 10, firstBeatWords: 230, otherBeatWords: 210,
    vocabulary: ["the", "ledger", "shows", "a", "shipment", "that", "contradicts", "official", "records"] },
  { name: "English cinematic alternate history (hypothetical matchup), 15 minutes", beats: 10, firstBeatWords: 240, otherBeatWords: 210,
    vocabulary: ["in", "this", "hypothetical", "clash", "two", "commanders", "never", "actually", "met"] },
];

function scenario(s: Scenario) {
  const narration = (beat: number, words: number) => Array.from({ length: words }, (_, i) => `${s.vocabulary[i % s.vocabulary.length]}${beat}x${i}`).join(" ");
  const beats = Array.from({ length: s.beats }, (_, i) => ({ type: "discovery", purpose: `block ${i}`, claims: [], narration: narration(i, i === 0 ? s.firstBeatWords : s.otherBeatWords) }));
  const script = { beats, storyPlan: { centralQuestion: "What changed?", openingPromise: "Follow the evidence.", firstAnswer: "x", endingAnswer: "y", sections: [] } } as unknown as EditorialScript;
  const catalog = narrationCatalog(beats);
  const first = (i: number) => catalog.find(e => e.beatIndex === i)!.id;
  // The critic says the first reward is delivered but cites a passage after word 150: the repair path runs.
  const late = catalog.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) > 160)!;
  const last = s.beats - 1;
  const raw = {
    sections: beats.map((_, i) => ({ excerptId: first(i), contribution: `information ${i}`, function: i === last ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "Delivered in the opening block" },
    ending: { resolvesPromise: true, evidence: { excerptId: first(last) }, explanation: "Resolved in the close" },
    findings: [],
  };
  const eligible = openingEvidence(beats);
  return { script, raw, eligible, late };
}
const response = (body: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(body) }] });
/** The exact shape persisted for incident 23d86d0a. */
const incidentAnswer = (excerptId: string) => ({ firstAnswer: { delivered: true, evidence: { excerptId, explanation: "" },
  explanation: "The opening establishes the concrete stakes and delivers a specific, verifiable detail early. ".repeat(7).trim() } });

for (const s of SCENARIOS) {
  test(`${s.name}: the incident response shape (empty extra evidence key) is accepted`, async () => {
    const { script, raw, eligible } = scenario(s);
    assert.ok(eligible.length > 0);
    const target = eligible.at(-1)!;
    const before = structuredClone(raw);
    const result = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "claude-sonnet-5", send: async () => response(incidentAnswer(target.id)) });
    assert.equal(result.firstAnswer.delivered, true);
    assert.equal(result.firstAnswer.evidence.quote, target.quote, "evidence is derived from the original narration");
    assert.deepEqual(raw, before, "the critic's original review is not mutated");
    assert.deepEqual(editorialBlockers(result), []);
  });

  test(`${s.name}: genuinely invalid answers still fail`, async () => {
    const { script, raw, eligible, late } = scenario(s);
    const ok = eligible[0].id;
    for (const bad of [
      { firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "late" } },                     // outside the first 150 words
      { firstAnswer: { delivered: true, evidence: { excerptId: "invented:b0:w1" }, explanation: "invented" } },        // invented evidence
      { firstAnswer: { delivered: "yes", evidence: { excerptId: ok }, explanation: "wrong type" } },                  // mistyped field
      { firstAnswer: { delivered: true, evidence: {}, explanation: "missing id" } },                                    // missing required field
      { firstAnswer: { delivered: true, evidence: { excerptId: ok, quote: "copied text" }, explanation: "x" } },       // unknown key WITH content
      { firstAnswer: { delivered: true, evidence: { excerptId: ok }, explanation: "x" }, findings: [] },                // tries to change other judgments
      { firstAnswer: { delivered: true, evidence: { excerptId: ok }, explanation: "" } },                               // required text empty
    ]) await assert.rejects(validateOrRepairOpeningReview({ rawReview: raw, script, model: "test", send: async () => response(bad) }), DocumentaryResponseError);
    // No payoff remains an editorial blocker even when the shape needed normalising.
    const none = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "test",
      send: async () => response({ firstAnswer: { delivered: false, evidence: { excerptId: ok, explanation: null }, explanation: "Only suspense" } }) });
    assert.ok(editorialBlockers(none).length > 0);
  });
}

test("retry and resume after an interruption reuse the committed response: exactly one paid call", async () => {
  const { script, raw, eligible } = scenario(SCENARIOS[1]);
  const ledger = new Map<string, ReturnType<typeof response>>();
  let paid = 0, interrupt = true;
  const send = async (p: { model: string; max_tokens: number } & Record<string, unknown>) => {
    const key = stableHash(p, 16);
    if (!ledger.has(key)) { paid++; ledger.set(key, response(incidentAnswer(eligible[0].id))); }
    if (interrupt) { interrupt = false; throw new Error("worker interrupted after the response was committed"); }
    return ledger.get(key)!;
  };
  await assert.rejects(validateOrRepairOpeningReview({ rawReview: raw, script, model: "claude-sonnet-5", send }));
  const resumed = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "claude-sonnet-5", send });
  const retried = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "claude-sonnet-5", send });
  assert.equal(paid, 1, "same request fingerprint, same committed response, no second charge");
  assert.deepEqual(resumed, retried);
});

test("normalisation removes only unrecognised keys with null/blank values, never recognised or informative ones", () => {
  const schema = z.object({ a: z.string(), comment: z.string().nullable(), nested: z.object({ id: z.string() }).strict(),
    list: z.array(z.object({ n: z.number() }).strict()) }).strict();
  const input = { a: "x", comment: null, extra: "  ", nested: { id: "1", note: null }, list: [{ n: 1, tag: "" }, { n: 2 }] };
  const frozen = structuredClone(input);
  const out = normalizeRecoverableFormat(schema, input);
  assert.deepEqual(out.value, { a: "x", comment: null, nested: { id: "1" }, list: [{ n: 1 }, { n: 2 }] });
  assert.equal(out.removed.length, 3);
  assert.ok(out.removed.every(p => !/extra|note|tag/.test(p)), "paths never echo unknown key names");
  assert.deepEqual(input, frozen, "the raw document is not mutated");
  assert.deepEqual(validateDocumentaryValue(schema, input), out.value);
  for (const bad of [{ ...frozen, extra: "content" }, { ...frozen, extra: [] }, { ...frozen, extra: {} }, { ...frozen, extra: 0 }, { ...frozen, extra: false }, { ...frozen, a: 1 }])
    assert.throws(() => validateDocumentaryValue(schema, bad), DocumentaryResponseError);
});

test("the same rule protects the visual anchor repair contract", () => {
  const catalog = [{ id: "r:b0:w0", beatIndex: 0, quote: "one two three four five" }, { id: "r:b0:w5", beatIndex: 0, quote: "six seven eight nine ten" }];
  const raw = { visuals: [{ excerptId: "missing", description: "a" }, { excerptId: "r:b0:w5", description: "b" }] };
  const fixed = applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "" }] });
  assert.equal(fixed.visuals[0].excerptId, "r:b0:w0");
  assert.throws(() => applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "better match" }] }), DocumentaryResponseError);
});

import { locateWordSequence, longestLiteralRun } from "./text-locate";
import { anchorCreativeDirectionQuotes, creativeDirectionIssues } from "./creative-direction";
import { editorialFixture } from "./editorial.test-fixtures";

test("editing marks: inner punctuation differences are anchored to the literal narration (dbc89879 pass 0)", () => {
  const narration = "Hannibal crossed the Alps in winter. Elephants died, men froze, and Rome still did not believe it.";
  assert.equal(locateWordSequence(narration, "elephants died men froze and Rome still did not believe it"), "Elephants died, men froze, and Rome still did not believe it");
  assert.equal(locateWordSequence(narration, "Rome believed it"), null, "a different sentence is never matched");
});

test("editing marks: a condensed copy keeps its longest literal run in the cited block only (e8048599 pass 0)", () => {
  const narration = "No ancient source records the battle — it never happened, and every number we use is a modern guess built on Herodotus and later chroniclers.";
  const condensed = "it never happened, and every number we use is a modern guess built on Herodotus";
  assert.equal(longestLiteralRun(narration, condensed + " alone"), "it never happened, and every number we use is a modern guess built on Herodotus");
  assert.equal(longestLiteralRun(narration, "the armies met at dawn and the river turned red with the blood of thousands"), null, "invented text is never anchored");
  assert.equal(longestLiteralRun(narration, "every number we use and then a long invented tail that the narration never says anywhere at all"), null, "a short run below the share stays rejected");
  // The measured e8048599 shape: 16 literal words of a 35-word mark, then a rewritten tail.
  const opening = "No ancient source records the battle — it never happened, and every number we use is a modern guess";
  assert.equal(longestLiteralRun(narration, opening + " that historians copied from one another across many centuries of retelling and doubt"), "No ancient source records the battle — it never happened, and every number we use is a modern guess");
});

test("the anchored draft passes the literal check without changing narration; an invented mark still fails", () => {
  const s = editorialFixture();
  const before = structuredClone(s.beats);
  const d = structuredClone(s.creativeDirection);
  const target = s.beats[2].narration.split(" ").slice(0, 12);
  d.protectInEdit[1] = { beatIndex: 2, quote: target.slice(0, 6).join(" ") + ", " + target.slice(6).join(" ") + " (abridged)" };
  assert.ok(creativeDirectionIssues(d, s.beats).length);
  assert.deepEqual(creativeDirectionIssues(anchorCreativeDirectionQuotes(d, s.beats), s.beats), []);
  assert.deepEqual(s.beats, before);
  d.protectInEdit[1] = { beatIndex: 2, quote: "A dramatic reveal that the narration never contains at any point" };
  assert.ok(creativeDirectionIssues(anchorCreativeDirectionQuotes(d, s.beats), s.beats).length);
});
