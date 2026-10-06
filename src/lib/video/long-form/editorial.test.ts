import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDocumentaryScript, LongFormScriptDurationError } from "./documentary-script";
import { editorialApprovalError, editorialBlockers, editorialScriptHash, validateEditorialReview,
  EditorialQualityError, type EditorialReport } from "./editorial";
import { editorialFixture, passingReview, repeatedPromiseFixture } from "./editorial.test-fixtures";

const input = { researchPack: { topic: "A legend examined", sources: [{ id: "s1", title: "Archive", kind: "primary" as const, notes: "The account is an allegation, not proof of a facility." }], openQuestions: [] },
  mode: "curiosity_documentary" as const, targetDurationSeconds: 180 };

test("semantic Dulce fixture: three different sentences trigger one bounded correction and a fresh review", async () => {
  const repeated = repeatedPromiseFixture(), repaired = editorialFixture();
  let writes = 0, reviews = 0; let report: EditorialReport | undefined;
  const beats = await generateDocumentaryScript({ ...input,
    parse: async ({ system, prompt }) => {
      writes++;
      assert.match(system, /No repitas una promesa con sinónimos/);
      if (writes === 2) { assert.match(prompt, /Tres bloques prometen/); assert.match(prompt, /BORRADOR ANTERIOR/); }
      return writes === 1 ? repeated.script : repaired;
    }, review: async ({ system, prompt }) => { reviews++; assert.match(system, /callbacks/); assert.ok(prompt.includes('"researchPack"'));
      return reviews === 1 ? repeated.review : passingReview(repaired); },
    onEditorialApproved: r => { report = r; },
  });
  assert.equal(writes, 2); assert.equal(reviews, 2); assert.deepEqual(beats, repaired.beats);
  assert.equal(report?.corrected, true); assert.equal(report?.reviews.length, 2);
  assert.equal(editorialApprovalError({ beats, editorial: report }), null);
});

test("persistent repetition blocks acceptance after one correction, never a third draft", async () => {
  const { script, review } = repeatedPromiseFixture(); let writes = 0, reads = 0, approved = false;
  await assert.rejects(generateDocumentaryScript({ ...input, parse: async () => { writes++; return script; },
    review: async () => { reads++; return review; }, onEditorialApproved: () => { approved = true; } }), EditorialQualityError);
  assert.equal(writes, 2); assert.equal(reads, 2); assert.equal(approved, false);
});

test("callback with a changed interpretation and a style suggestion needs no correction", async () => {
  const script = editorialFixture(), review = passingReview(script); let writes = 0;
  review.sections[3].function = "reversal";
  review.findings.push({ kind: "pacing", severity: "suggestion", evidence: [review.sections[3]], explanation: "Podría respirar más.", repair: "Considerar una pausa." });
  await generateDocumentaryScript({ ...input, parse: async () => { writes++; return script; }, review: async () => review });
  assert.equal(writes, 1);
});

test("invented evidence, missing/duplicate coverage and a late first answer fail closed", () => {
  const script = editorialFixture();
  const variants = [passingReview(script), passingReview(script), passingReview(script), passingReview(script)];
  variants[0].sections[1].quote = "invented words not present";
  variants[1].sections.pop();
  variants[2].sections[1].beatIndex = 0;
  variants[3].firstAnswer.evidence = variants[3].sections[3];
  for (const review of variants) assert.throws(() => validateEditorialReview(review, script));
});

test("empty suspense and an unresolved ending cannot be approved by omitting findings", () => {
  const script = editorialFixture(), review = passingReview(script);
  review.firstAnswer.delivered = false; review.ending.resolvesPromise = false;
  assert.equal(editorialBlockers(validateEditorialReview(review, script)).length, 2);
});

test("uncertain reviewer failure is not retried and cannot become an approved script", async () => {
  let writes = 0, reads = 0;
  await assert.rejects(generateDocumentaryScript({ ...input, parse: async () => { writes++; return editorialFixture(); },
    review: async () => { reads++; throw new Error("RECONCILIATION_REQUIRED"); } }), /RECONCILIATION_REQUIRED/);
  assert.equal(writes, 1); assert.equal(reads, 1);
});

test("length and editorial problems share the same single correction allowance", async () => {
  const long = editorialFixture(153), short = editorialFixture(90); let writes = 0, reviews = 0;
  await generateDocumentaryScript({ ...input, parse: async () => ++writes === 1 ? long : short,
    review: async () => passingReview(++reviews === 1 ? long : short) });
  assert.equal(writes, 2); assert.equal(reviews, 2);
  writes = 0;
  await assert.rejects(generateDocumentaryScript({ ...input, parse: async () => { writes++; return long; }, review: async () => passingReview(long) }), LongFormScriptDurationError);
  assert.equal(writes, 2);
});

test("nonexistent source attribution blocks acceptance even if a critic approves it", async () => {
  const script = editorialFixture(); script.beats[0].claims = [{ id: "c1", text: "Unsupported", support: "sourced", sourceIds: ["invented"] }];
  await assert.rejects(generateDocumentaryScript({ ...input, parse: async () => script, review: async () => passingReview(script) }), EditorialQualityError);
});

test("metadata binds the approved narration, claims and visual plan; legacy masters stay valid", async () => {
  const script = editorialFixture(); let report!: EditorialReport;
  await generateDocumentaryScript({ ...input, parse: async () => script, review: async () => passingReview(script), onEditorialApproved: r => { report = r; } });
  assert.equal(report.scriptHash, editorialScriptHash(script.beats));
  for (const field of ["narration", "purpose", "visuals", "claims"] as const) {
    const changed = structuredClone(script);
    Object.assign(changed.beats[0], { [field]: field === "claims" || field === "visuals" ? [] : "changed" });
    // Empty claims were already empty: make a real content change.
    if (field === "claims") changed.beats[0].claims = [{ id: "new", text: "new", support: "unverified", sourceIds: [] }];
    assert.match(editorialApprovalError({ beats: changed.beats, editorial: report })!, /cambió/);
  }
  assert.equal(editorialApprovalError({ beats: script.beats }), null);
  assert.ok(editorialApprovalError({ beats: script.beats, editorial: { ...report, status: "pending" } }));
});

test("a test writer cannot silently bypass the critic or call the live API", async () => {
  await assert.rejects(generateDocumentaryScript({ ...input, parse: async () => editorialFixture() }), /revisor editorial simulado/);
});
