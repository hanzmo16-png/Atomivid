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

test("ellipsis quotes expand to the literal span including omitted words; ambiguity and invented fragments fail", async()=>{
 const {resolveEditorialQuote}=await import('./editorial-evidence');
 const n='The first dated account did not prove the allegation. The later archive changed the interpretation.';
 assert.equal(resolveEditorialQuote(n,'The first dated account...The later archive changed'), 'The first dated account did not prove the allegation. The later archive changed');
 for(const q of ['invented dated account...The later archive changed','The later archive changed...The first dated account','...The later archive changed','The first...The later archive changed']) assert.equal(resolveEditorialQuote(n,q),null);
 assert.equal(resolveEditorialQuote(n+' The first dated account returned.','The first dated account...The later archive changed'),null);
});

test("citation repair cannot change reviewer judgments, select other beats, omit defects or duplicate paths", async()=>{
 const {applyEditorialCitationRepairs,EditorialEvidenceError}=await import('./editorial-evidence');
 const script=editorialFixture(),review=passingReview(script),quote=review.sections[1].quote;
 review.sections[1].quote='Missing';
 const repaired=applyEditorialCitationRepairs(review,script.beats,{replacements:[{path:'sections/1',quote}]});
 assert.equal(repaired.sections[1].quote,quote);assert.equal(review.sections[1].quote,'Missing');
 assert.deepEqual({...repaired,sections:[]},{...review,sections:[]});
 for(const replacements of [[],[{path:'ending',quote}],[{path:'sections/1',quote:script.beats[0].narration}],[{path:'sections/1',quote},{path:'sections/1',quote}],[{path:'sections/1',quote:'not actually present here'}]])
  assert.throws(()=>applyEditorialCitationRepairs(review,script.beats,{replacements}),EditorialEvidenceError);
});

test("one known malformed citation gets a bounded correction and complete editorial revalidation",async()=>{
 const script=editorialFixture(),review=passingReview(script),quote=review.sections[1].quote;
 review.sections[1].quote='Missing';let repaired=0,approved=false;
 await generateDocumentaryScript({...input,parse:async()=>script,review:async()=>review,repairEvidence:async prompt=>{
  repaired++;assert.match(prompt,/citation-repair-v1/);return {replacements:[{path:'sections/1',quote}]};
 },onEditorialApproved:()=>{approved=true;}});
 assert.equal(repaired,1);assert.equal(approved,true);
});

test("citation repair never upgrades blocking findings to approval",async()=>{
 const {script,review}=repeatedPromiseFixture();const quote=review.sections[1].quote;review.sections[1].quote='Missing';
 let repairs=0,approved=false;
 await assert.rejects(generateDocumentaryScript({...input,parse:async()=>script,review:async()=>review,
  repairEvidence:async()=>{repairs++;return {replacements:[{path:'sections/1',quote}]};},onEditorialApproved:()=>{approved=true;}}));
 assert.equal(repairs,1,'correction allowance is shared across both script drafts');assert.equal(approved,false);
});

test("failed or uncertain evidence correction stops without another call or approval",async()=>{
 const script=editorialFixture(),review=passingReview(script);review.sections[1].quote='Missing';
 for(const failure of ['uncertain','invalid']){
  let repairs=0,approved=false;
  await assert.rejects(generateDocumentaryScript({...input,parse:async()=>script,review:async()=>review,
   repairEvidence:async()=>{repairs++;if(failure==='uncertain')throw Error('RECONCILIATION_REQUIRED');return {replacements:[]};},onEditorialApproved:()=>{approved=true;}}));
  assert.equal(repairs,1);assert.equal(approved,false);
 }
});

test("supplementary unique claim IDs remain audited references, never fabricated quotations",()=>{
 const script=editorialFixture(),review=passingReview(script);
 script.beats[3].claims=[{id:'c4-5',text:'An inference about the archive.',support:'inference',sourceIds:['s1']}];
 review.findings.push({kind:'unsupported_claim',severity:'suggestion',evidence:[review.sections[3],{beatIndex:4,quote:'c4-5'}],explanation:'A limited inference.',repair:'Qualify the wording.'});
 const resolved=validateEditorialReview(review,script);
 assert.equal(resolved.findings.length,1);assert.equal(resolved.findings[0].severity,'suggestion');
 assert.equal(resolved.findings[0].explanation,review.findings[0].explanation);assert.equal(resolved.findings[0].repair,review.findings[0].repair);
 assert.deepEqual(resolved.findings[0].evidence,[{beatIndex:review.sections[3].beatIndex,quote:review.sections[3].quote}]);
 assert.deepEqual(resolved.claimReferences,[{findingIndex:0,claimId:'c4-5',beatIndex:3,originalBeatIndex:4}]);
 assert.deepEqual(validateEditorialReview(resolved,script),resolved,'stored references revalidate without duplication');
 assert.equal(review.findings[0].evidence.length,2,'raw response is unchanged');
});

test("claim references cannot replace mandatory narrative evidence or hide blocking findings",()=>{
 const script=editorialFixture(),review=passingReview(script);
 script.beats[3].claims=[{id:'c4-5',text:'An inference.',support:'inference',sourceIds:['s1']}];
 const finding={kind:'unsupported_claim' as const,severity:'blocking' as const,evidence:[review.sections[3],{beatIndex:4,quote:'c4-5'}],explanation:'Material overstatement.',repair:'Correct the unsupported assertion.'};
 review.findings.push(finding);
 assert.equal(editorialBlockers(validateEditorialReview(review,script)).length,1);
 for(const evidence of [[{beatIndex:4,quote:'c4-5'}],[review.sections[2],{beatIndex:4,quote:'c4-5'}],[review.sections[3],{beatIndex:4,quote:'unknown-id'}]]){
  const bad=structuredClone(review);bad.findings[0].evidence=evidence;assert.throws(()=>validateEditorialReview(bad,script));
 }
 const bad=structuredClone(review);bad.sections[3].quote='c4-5';assert.throws(()=>validateEditorialReview(bad,script));
 const duplicate=structuredClone(script);duplicate.beats[2].claims=script.beats[3].claims;assert.throws(()=>validateEditorialReview(review,duplicate));
 const tampered=validateEditorialReview(review,script);tampered.claimReferences![0].beatIndex=2;assert.throws(()=>validateEditorialReview(tampered,script));
});

test('legacy saved correction relocates only unique literal finding evidence and records its origin',async()=>{
 const {applyEditorialCitationRepairs}=await import('./editorial-evidence');
 const script=editorialFixture(),review=passingReview(script),quote=review.sections[3].quote;
 review.findings=[{kind:'unsupported_claim',severity:'blocking',explanation:'Evidence must support this claim.',repair:'Qualify this claim.',evidence:[{beatIndex:4,quote:'not in narration'}]}];
 const raw=structuredClone(review),patch={replacements:[{path:'findings/0/0',quote}]};
 const resolved=validateEditorialReview(applyEditorialCitationRepairs(review,script.beats,patch),script);
 assert.deepEqual(review,raw);assert.equal(editorialBlockers(resolved).length,1);
 assert.equal(resolved.findings[0].evidence[0].beatIndex,3);
 assert.deepEqual(resolved.citationLocations,[{path:'findings/0/0',originalBeatIndex:4,beatIndex:3,quote}]);
 assert.deepEqual(validateEditorialReview(resolved,script),resolved);
 const duplicate=structuredClone(script);duplicate.beats[2].narration+=' '+quote;
 assert.throws(()=>applyEditorialCitationRepairs(review,duplicate.beats,patch));
 const bad=structuredClone(resolved);bad.findings[0].evidence[0].quote='changed words here';assert.throws(()=>validateEditorialReview(bad,script));
});

test('persistent story defects have a quality stage and actionable message distinct from reference failures',async()=>{
 const {documentaryFormError}=await import('./form-error');const {script,review}=repeatedPromiseFixture();review.sections[2].function='restatement';let lastStage='';
 await assert.rejects(generateDocumentaryScript({...input,parse:async()=>script,review:async()=>review,onStage:async label=>{lastStage=label;}}),e=>{
  assert.ok(e instanceof EditorialQualityError);const message=documentaryFormError(e,'fixture');assert.match(message,/repite ideas/);assert.match(message,/corrección prevista ya se utilizó/);assert.ok(!message.includes(review.sections[2].contribution));return true;
 });
 assert.equal(lastStage,'Comprobando calidad narrativa');
});

test('failed review retains the exact latest draft without approving it or mutating generation',async()=>{
 const {script,review}=repeatedPromiseFixture();
 const snapshots:import('./documentary-script').DocumentaryDraft[]=[];
 let writes=0,approved=false;
 await assert.rejects(generateDocumentaryScript({...input,
  parse:async()=>{writes++;return structuredClone(script);},review:async()=>review,
  onDraft:async draft=>{snapshots.push(structuredClone(draft));draft.script.beats[0].narration='Callback mutation must not reach generation';},
  onEditorialApproved:()=>{approved=true;}}),EditorialQualityError);
 assert.equal(writes,2);assert.equal(approved,false);
 assert.deepEqual(snapshots.map(s=>[s.pass,Boolean(s.review)]),[[0,false],[0,true],[1,false],[1,true]]);
 for(const snapshot of snapshots){assert.equal(snapshot.status,'unapproved');assert.equal(snapshot.script.beats[0].narration,script.beats[0].narration);}
 assert.equal(snapshots.at(-1)?.review?.findings[0].severity,'blocking');
});

test('draft save failure stops before another paid review or approval',async()=>{
 let reviews=0,approved=false;
 await assert.rejects(generateDocumentaryScript({...input,parse:async()=>editorialFixture(),
  review:async()=>{reviews++;return passingReview(editorialFixture());},
  onDraft:async()=>{throw Error('CHECKPOINT_WRITE_FAILED');},onEditorialApproved:()=>{approved=true;}}),/CHECKPOINT_WRITE_FAILED/);
 assert.equal(reviews,0);assert.equal(approved,false);
});
