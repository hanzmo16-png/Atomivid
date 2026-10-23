// Independent audit of PR #191 (copied into a throw-away worktree of 43b865d by the audit workflow; never
// committed to the PR). No provider calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { narrationCatalog } from "./narration-catalog";
import { editorialBlockers, type EditorialScript } from "./editorial";
import { openingEvidence, validateOrRepairOpeningReview } from "./editorial-opening-repair";
import { normalizeToContract, extractJsonDocument } from "./response-normalizer";
import { readDocumentaryJson, validateDocumentaryValue, DocumentaryResponseError } from "./json-response";
import { longestSharedSpan, anchorCreativeDirectionSpans, creativeDirectionIssues } from "./creative-direction";
import { editorialFixture } from "./editorial.test-fixtures";
import { z } from "zod";

function scenario(beats = 10, firstWords = 230) {
  const narration = (b: number, n: number) => Array.from({ length: n }, (_, i) => `w${b}x${i}`).join(" ");
  const bs = Array.from({ length: beats }, (_, i) => ({ type: "discovery", purpose: `p${i}`, claims: [], narration: narration(i, i === 0 ? firstWords : 200) }));
  const script = { beats: bs, storyPlan: { centralQuestion: "q", openingPromise: "p", firstAnswer: "a", endingAnswer: "e", sections: [] } } as unknown as EditorialScript;
  const cat = narrationCatalog(bs), first = (i: number) => cat.find(e => e.beatIndex === i)!.id;
  const late = cat.find(e => e.beatIndex === 0 && Number(e.id.split(":w")[1]) > 160)!;
  const raw = { sections: bs.map((_, i) => ({ excerptId: first(i), contribution: `c${i}`, function: i === beats - 1 ? "resolution" : "new_information" })),
    firstAnswer: { delivered: true, evidence: { excerptId: late.id }, explanation: "x" }, ending: { resolvesPromise: true, evidence: { excerptId: first(beats - 1) }, explanation: "e" }, findings: [] };
  return { script, raw, eligible: openingEvidence(bs) };
}
const resp = (body: unknown, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] });

test("A1 capa C never approves: garbage, truncation, prose, empty object, wrong types", async () => {
  const { script, raw } = scenario();
  for (const r of [resp("not json"), resp({ firstAnswer: { delivered: true } }, "max_tokens"), resp("Sure! Here is the JSON: {}"), resp({}), resp({ firstAnswer: { delivered: "true", evidence: { excerptId: "x" }, explanation: "y" } })]) {
    const out = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: async () => r });
    assert.equal(out.firstAnswer.delivered, false);
    assert.ok(editorialBlockers(out).length > 0);
  }
});

test("A2 R2 must not silently overturn a contradictory verdict placed inside evidence", async () => {
  const { script, raw, eligible } = scenario();
  const out = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t",
    send: async () => resp({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, delivered: false, explanation: "No concrete reward appears before word 150" }, explanation: "ok" } }) });
  // Recorded as observed behaviour (assertion documents the finding): the contradictory content is dropped.
  assert.equal(out.firstAnswer.delivered, true, "FINDING: R2 drops evidence.delivered=false and the stricter verdict is lost");
});

test("A3 R2 only applies when excerptId is present; a quote-only evidence never approves", async () => {
  const { script, raw, eligible } = scenario();
  const out = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t",
    send: async () => resp({ firstAnswer: { delivered: true, evidence: { quote: eligible[0].quote }, explanation: "ok" } }) });
  assert.equal(out.firstAnswer.delivered, false);
});

test("A4 __proto__ / constructor keys do not pollute prototypes", () => {
  const schema = z.object({ a: z.string() }).strict();
  const value = JSON.parse('{"a":"x","__proto__":"","constructor":null}');
  const out = normalizeToContract(schema, value);
  assert.deepEqual(Object.keys(out.value as object), ["a"]);
  assert.equal(({} as Record<string, unknown>).a, undefined);
});

test("A5 normalisation is idempotent and never mutates the raw document", () => {
  const schema = z.object({ e: z.object({ excerptId: z.string() }).strict() }).strict();
  const raw = { e: { excerptId: "id", quote: "q", note: "" } };
  const frozen = structuredClone(raw);
  const once = normalizeToContract(schema, raw), twice = normalizeToContract(schema, once.value);
  assert.deepEqual(raw, frozen);
  assert.deepEqual(once.value, twice.value);
  assert.equal(twice.actions.length, 0);
});

test("A6 structured extra content (objects/arrays) and missing/enum errors still fail", () => {
  const schema = z.object({ e: z.object({ excerptId: z.string() }).strict(), k: z.enum(["a", "b"]) }).strict();
  for (const bad of [{ e: { excerptId: "id", extra: { x: 1 } }, k: "a" }, { e: { excerptId: "id", extra: [1] }, k: "a" }, { e: { excerptId: "id" }, k: "c" }, { e: {}, k: "a" }, { e: { excerptId: "id" }, k: "a", top: "content" }])
    assert.throws(() => validateDocumentaryValue(schema, bad), DocumentaryResponseError);
});

test("A7 JSON extraction still refuses prose and partial documents", () => {
  for (const t of ['Here: {"a":1}', '{"a":1} trailing', '```json\n{"a":1}\n``` and more', '{"a":']) assert.throws(() => extractJsonDocument(t));
  assert.deepEqual(extractJsonDocument('﻿```JSON{"a":1}```'), { a: 1 });
  assert.throws(() => readDocumentaryJson(resp('{"a":1}', "max_tokens")), DocumentaryResponseError);
});

test("A8 span anchoring across a spaced em dash (shape of e8048599 protectInEdit[2])", () => {
  const narration = "No ancient source records the battle — it never happened, and every number we use is a modern guess built on Herodotus and later chroniclers.";
  const quote = "No ancient source records the battle — it never happened, and every number we use is a modern guess that historians copied from one another across many centuries of retelling and doubt";
  const span = longestSharedSpan(narration, quote);
  // Observed behaviour recorded for the report: null means the dash splits the literal run.
  console.log("A8_SPAN", JSON.stringify({ found: span !== null, words: span ? span.split(/\s+/).length : 0 }));
});

test("A9 span anchoring never anchors invented or below-threshold marks and never edits narration", () => {
  const s = editorialFixture(); const before = structuredClone(s.beats); const d = structuredClone(s.creativeDirection);
  d.protectInEdit[1] = { beatIndex: 2, quote: "A dramatic reveal that the narration never contains at any point at all" };
  assert.ok(creativeDirectionIssues(anchorCreativeDirectionSpans(d, s.beats), s.beats).length);
  assert.deepEqual(s.beats, before);
});

test("A11 retry after interruption: one paid call, same verdict (incident shape)", async () => {
  const { script, raw, eligible } = scenario();
  const ledger = new Map<string, ReturnType<typeof resp>>(); let paid = 0, crash = true;
  const send = async (p: Record<string, unknown>) => { const k = stableHash(p, 16);
    if (!ledger.has(k)) { paid++; ledger.set(k, resp({ firstAnswer: { delivered: true, evidence: { excerptId: eligible[0].id, explanation: "" }, explanation: "ok" } })); }
    if (crash) { crash = false; throw new Error("interrupted"); } return ledger.get(k)!; };
  await assert.rejects(validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: send as never }));
  const a = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: send as never });
  const b = await validateOrRepairOpeningReview({ rawReview: raw, script, model: "t", send: send as never });
  assert.equal(paid, 1); assert.deepEqual(a, b); assert.equal(a.firstAnswer.delivered, true);
});

test("A12 isolate: inner-comma + 12-word mark (PR #190 case) under span anchoring", () => {
  const s = editorialFixture(); const d = structuredClone(s.creativeDirection);
  const target = s.beats[2].narration.split(" ").slice(0, 12);
  d.protectInEdit[1] = { beatIndex: 2, quote: target.slice(0, 6).join(" ") + ", " + target.slice(6).join(" ") + " (abridged)" };
  const span = longestSharedSpan(s.beats[2].narration, d.protectInEdit[1].quote);
  const anchored = anchorCreativeDirectionSpans(d, s.beats) as typeof d;
  console.log("A12", JSON.stringify({ span: span ? span.split(/\s+/).length : null, protect: anchored.protectInEdit.map(p => ({ b: p.beatIndex, literal: s.beats[p.beatIndex].narration.includes(p.quote), words: p.quote.split(/\s+/).length })),
    distinct: new Set(anchored.protectInEdit.map(p => `${p.beatIndex}:${p.quote}`)).size, issues: creativeDirectionIssues(anchored, s.beats) }));
});

test("A13 coverage gap: repair contracts parsed outside validateDocumentaryValue keep rejecting empty extra keys", async () => {
  const { applyVisualAnchorRepair } = await import("./visual-anchor-repair");
  const catalog = [{ id: "r:b0:w0", beatIndex: 0, quote: "one two three four five" }, { id: "r:b0:w5", beatIndex: 0, quote: "six seven eight nine ten" }];
  const raw = { visuals: [{ excerptId: "missing", description: "a" }, { excerptId: "r:b0:w5", description: "b" }] };
  let rejected = false;
  try { applyVisualAnchorRepair(raw, catalog, [0], { replacements: [{ index: 0, excerptId: "r:b0:w0", reason: "" }] }); } catch { rejected = true; }
  console.log("A13", JSON.stringify({ visualAnchorEmptyExtraKeyRejected: rejected }));
});
