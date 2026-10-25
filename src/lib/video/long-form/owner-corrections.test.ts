// Owner corrections on a persisted, approved script (e8048599). SIMULATED, USD 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOwnerCorrections, type PersistedScript } from "./owner-corrections";
import { editorialScriptHash } from "./editorial";
import { withOwnerCorrections, ownerCorrectionsFor } from "./owner-corrections-registry";

const N0 = "Herodotus wrote his Histories around 440 BCE, roughly fifty years after the battle, from interviews with survivors.";
const N1 = "A pass eight meters wide at its narrowest point did not care how many riders were waiting behind it. Cavalry needs room.";
function script(): PersistedScript {
  const beats = [
    { id: "beat-1", type: "context", purpose: "source", narration: N0, claims: [{ id: "c0-1", text: "Herodotus wrote around 440 BCE", support: "sourced", sourceIds: ["web-1"] }],
      visuals: [{ description: "scroll", quote: "Herodotus wrote his Histories around 440 BCE", beatClass: "EVIDENCE" }] },
    { id: "beat-2", type: "turn", purpose: "terrain", narration: N1, claims: [],
      visuals: [{ description: "pass", quote: "A pass eight meters wide at its narrowest point", beatClass: "PLACE" }, { description: "riders", quote: "Cavalry needs room.", beatClass: "PLACE" }] },
  ];
  const editorial = { version: "editorial-v2", status: "approved", model: "m", corrected: false, scriptHash: "", storyPlan: {} as never,
    creativeDirection: { signatureDetail: { beatIndex: 1, quote: "A pass eight meters wide at its narrowest point did not care" } },
    reviews: [{ sections: [{ beatIndex: 0, quote: "around 440 BCE, roughly fifty years after", contribution: "c", function: "setup" }, { beatIndex: 1, quote: "did not care how many riders", contribution: "c", function: "consequence" }],
      firstAnswer: { delivered: true, evidence: { beatIndex: 1, quote: "A pass eight meters wide" }, explanation: "e" }, ending: { resolvesPromise: true, evidence: { beatIndex: 1, quote: "Cavalry needs room." }, explanation: "e" }, findings: [] }] };
  const s = { topic: "t", beats, editorial } as unknown as PersistedScript;
  s.editorial!.scriptHash = editorialScriptHash(beats as never);
  return s;
}
// Stand-in for editorialApprovalError on this synthetic script: hash + every review quote located.
const validate = (s: PersistedScript) => {
  if (s.editorial!.scriptHash !== editorialScriptHash(s.beats as never)) return "hash";
  for (const r of s.editorial!.reviews) for (const q of [...r.sections, r.firstAnswer.evidence, r.ending.evidence]) if (!s.beats[q.beatIndex].narration.includes(q.quote)) return `review quote lost: ${q.quote}`;
  return null;
};
const PATCHES = [
  { beatIndex: 0, find: "around 440 BCE, roughly fifty years after the battle", replace: "a few decades after the battle, most likely around 430 BCE", reason: "date" },
  { beatIndex: 1, find: "A pass eight meters wide at its narrowest point", replace: "A pass only a few meters wide at its narrowest points", reason: "width" },
];

test("narration, scene quotes, editorial marks, review citations and the approval hash move together", () => {
  const before = script();
  const r = applyOwnerCorrections(before, { job: "j", patches: PATCHES, claimPatches: [{ beatIndex: 0, claimId: "c0-1", text: "Herodotus wrote a few decades after the battle, most likely around 430 BCE", reason: "date" }] }, "test", validate);
  assert.equal(r.ok, true, r.errors.join("; "));
  const s = r.script;
  assert.match(s.beats[0].narration, /around 430 BCE/); assert.doesNotMatch(s.beats[1].narration, /eight meters/);
  assert.equal(s.editorial!.scriptHash, editorialScriptHash(s.beats as never), "hash re-bound to the corrected beats");
  const rec = (s.editorial as unknown as { ownerCorrections: { approvedScriptHash: string; reviewQuotesUpdated: number; claims: unknown[] } }).ownerCorrections;
  assert.equal(rec.approvedScriptHash, before.editorial!.scriptHash, "the approved hash is kept for audit");
  assert.ok(rec.reviewQuotesUpdated >= 2, `review quotes updated: ${rec.reviewQuotesUpdated}`);
  assert.equal(rec.claims.length, 1); assert.match(String((s.beats[0].claims as { text: string }[])[0].text), /430 BCE/);
  assert.match(String((s.editorial!.creativeDirection as { signatureDetail: { quote: string } }).signatureDetail.quote), /only a few meters wide/);
  assert.equal(s.beats.every((b) => (b.visuals as unknown[]).every((v) => !(v as Record<string, unknown>).__reviewQuote)), true, "shadow scenes never leak");
  assert.equal((s.beats[1].visuals as unknown[]).length, 2, "scene count and order unchanged");
  assert.equal(before.beats[0].narration, N0, "the original is not modified");
});

test("all or nothing: an unknown passage, an unknown claim or a failing final validation changes nothing", () => {
  const base = script();
  for (const c of [
    { job: "j", patches: [{ ...PATCHES[0], find: "not in the text" }] },
    { job: "j", patches: PATCHES, claimPatches: [{ beatIndex: 0, claimId: "missing", text: "x", reason: "r" }] },
  ]) { const r = applyOwnerCorrections(base, c, "t", validate); assert.equal(r.ok, false); assert.equal(r.script, base); }
  const r = applyOwnerCorrections(base, { job: "j", patches: PATCHES }, "t", (s) => (s === base ? null : "rejected"));
  assert.equal(r.ok, false); assert.match(r.errors[0], /no supera la validación/); assert.equal(r.script, base);
});

test("registry: only the registered job is touched; e8048599 carries its corrections", () => {
  const s = script();
  assert.equal(withOwnerCorrections("00000000-0000-4000-8000-000000000000", s), s);
  const e = ownerCorrectionsFor("e8048599-cf92-45e8-95c8-f145cb9d3be2");
  assert.ok(e && e.corrections.patches.length >= 8 && e.source.endsWith("correcciones.json"));
});
