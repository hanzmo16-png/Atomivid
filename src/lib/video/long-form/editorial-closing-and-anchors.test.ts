// Regressions for the two production rejections of 2026-10-22 (jobs 290de42b and dbc89879): in both the
// editorial critic raised NO blocking finding, yet the paid draft failed. No provider calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { editorialFixture, passingReview } from "./editorial.test-fixtures";
import { editorialBlockers } from "./editorial";
import { anchorCreativeDirectionQuotes, creativeDirectionIssues } from "./creative-direction";

function outroReview() {
  const script = editorialFixture();
  const review = passingReview(script);
  const last = script.beats.length - 1;
  review.sections[last - 1].function = "resolution";
  review.sections[last].function = "restatement";
  review.ending.evidence = { beatIndex: last - 1, quote: script.beats[last - 1].narration.split(" ").slice(0, 7).join(" ") };
  return { script, review, last };
}

test("a closing outro/CTA after the cited resolution is not a repetition blocker (dbc89879)", () => {
  const { review } = outroReview();
  assert.deepEqual(editorialBlockers(review), []);
});

test("the critic's own blocking finding on that closing block still blocks it", () => {
  const { script, review, last } = outroReview();
  review.findings.push({ kind: "padding", severity: "blocking", evidence: [{ beatIndex: last, quote: script.beats[last].narration.split(" ").slice(0, 6).join(" ") }],
    explanation: "El cierre rellena sin aportar.", repair: "Acórtalo." });
  const blockers = editorialBlockers(review);
  assert.ok(blockers.some(b => b.includes("El cierre rellena sin aportar.")));
  assert.ok(blockers.some(b => b.includes(`bloque ${last + 1}`)), "the closing exemption no longer applies");
});

test("a restatement in the middle, or a closing block far from the resolution, still blocks", () => {
  const mid = outroReview();
  mid.review.sections[1].function = "restatement";
  assert.ok(editorialBlockers(mid.review).some(b => b.includes("bloque 2")));
  const far = outroReview();
  far.review.ending.evidence = { beatIndex: 2, quote: far.script.beats[2].narration.split(" ").slice(0, 7).join(" ") };
  assert.ok(editorialBlockers(far.review).some(b => b.includes(`bloque ${far.last + 1}`)));
  const unresolved = outroReview();
  unresolved.review.ending.resolvesPromise = false;
  assert.ok(editorialBlockers(unresolved.review).some(b => b.includes(`bloque ${unresolved.last + 1}`)));
});

test("editing marks with typographic/edge/case differences are re-anchored to the original narration (290de42b)", () => {
  const s = editorialFixture();
  const original = structuredClone(s.beats);
  const d = structuredClone(s.creativeDirection);
  const exact = d.shareableLine.quote;
  d.shareableLine.quote = `“${exact.replace(/'/g, "’").toUpperCase()}.”`;
  assert.ok(creativeDirectionIssues(d, s.beats).length, "precondition: the unanchored mark fails the literal check");
  const anchored = anchorCreativeDirectionQuotes(d, s.beats);
  // The original span is returned (edge punctuation of the model's copy is not part of the match).
  assert.ok(s.beats[anchored.shareableLine.beatIndex].narration.includes(anchored.shareableLine.quote));
  assert.equal(anchored.shareableLine.quote, exact.replace(/[\s"'.,;:!?]+$/, ""));
  assert.deepEqual(creativeDirectionIssues(anchored, s.beats), []);
  assert.deepEqual(s.beats, original, "narration is never modified");
});

test("a mark pointing at the wrong block moves only when its passage is unique elsewhere", () => {
  const s = editorialFixture();
  const d = structuredClone(s.creativeDirection);
  const target = d.protectInEdit[0];
  const right = target.beatIndex, wrong = (right + 1) % s.beats.length;
  d.protectInEdit[0] = { beatIndex: wrong, quote: target.quote };
  const anchored = anchorCreativeDirectionQuotes(d, s.beats);
  assert.deepEqual(anchored.protectInEdit[0], target);
});

test("an invented passage is never repaired: the literal check still rejects it", () => {
  const s = editorialFixture();
  const d = structuredClone(s.creativeDirection);
  d.signatureDetail.quote = "This sentence never appeared anywhere in the script";
  const anchored = anchorCreativeDirectionQuotes(d, s.beats);
  assert.equal(anchored.signatureDetail.quote, d.signatureDetail.quote);
  assert.ok(creativeDirectionIssues(anchored, s.beats).length);
  assert.equal(anchorCreativeDirectionQuotes({ not: "valid" }, s.beats).not, "valid", "invalid metadata is returned untouched");
});
