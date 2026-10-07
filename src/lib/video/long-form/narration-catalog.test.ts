import {test} from 'node:test';
import assert from 'node:assert/strict';
import {narrationCatalog,resolveReferencedReview} from './narration-catalog';
import {editorialFixture,passingReview} from './editorial.test-fixtures';
import {validateEditorialReview,editorialBlockers} from './editorial';
import {generateDocumentaryScript,DocumentaryScriptSchema} from './documentary-script';
function fixture(){
 const script=editorialFixture(),review=passingReview(script),catalog=narrationCatalog(script.beats);
 const ref=(beat:number)=>({excerptId:catalog.find(e=>e.beatIndex===beat)!.id});
 const raw={...review,sections:review.sections.map(({beatIndex,quote,...rest})=>({...rest,...ref(beatIndex)})),firstAnswer:{...review.firstAnswer,evidence:ref(0)},ending:{...review.ending,evidence:ref(4)}};
 return {script,raw,catalog};
}
test('catalog contains only exact excerpts bound to immutable narration, including punctuation and short tails',()=>{
 for(let length=5;length<42;length++){
  const narration=Array.from({length},(_,i)=>i%2?`word${i},`:`“word${i}”`).join('  '),beats=[{narration}];
  const catalog=narrationCatalog(beats);assert.equal(new Set(catalog.map(e=>e.id)).size,catalog.length);
  for(const e of catalog){assert.ok(narration.includes(e.quote));assert.ok(e.quote.split(/\s+/).length>=5);assert.ok(e.quote.split(/\s+/).length<=12);}
  for(const word of narration.split(/\s+/))assert.ok(catalog.some(e=>e.quote.includes(word)));
  assert.deepEqual(narrationCatalog(beats),catalog);assert.notEqual(narrationCatalog([{narration:narration+' changed'}])[0].id,catalog[0].id);
 }
});
test('referenced critic cannot invent quotes, locations, stale IDs, missing coverage or hide blockers',()=>{
 const {script,raw,catalog}=fixture();const validated=validateEditorialReview(resolveReferencedReview(raw,script.beats),script);
 assert.equal(validated.sections.length,script.beats.length);
 for(const patch of [{excerptId:'unknown'},{excerptId:'unknown',quote:'invented words that never appear'}]){
  const bad=structuredClone(raw);Object.assign(bad.sections[0],patch);assert.throws(()=>resolveReferencedReview(bad,script.beats));
 }
 // The ID is authoritative: a stray copied quote or beatIndex is ignored, never trusted.
 for(const patch of [{quote:'invented',excerptId:catalog[0].id},{beatIndex:2,excerptId:catalog[0].id}]){
  const extra=structuredClone(raw);Object.assign(extra.sections[0],patch);const resolved=resolveReferencedReview(extra,script.beats);
  assert.equal(resolved.sections[0].beatIndex,0);assert.equal(resolved.sections[0].quote,catalog[0].quote);
 }
 const changed=structuredClone(script);changed.beats[0].narration+=' Changed draft.';assert.throws(()=>resolveReferencedReview(raw,changed.beats));
 const missing=structuredClone(raw);missing.sections[4]=missing.sections[3];assert.throws(()=>validateEditorialReview(resolveReferencedReview(missing,script.beats),script));
 const blocked={...raw,findings:[{kind:'padding',severity:'blocking',evidence:[{excerptId:catalog[0].id}],explanation:'No new information.',repair:'Add a consequence.'}]};
 assert.equal(editorialBlockers(validateEditorialReview(resolveReferencedReview(blocked,script.beats),script)).length,1);
});
test('catalog contract flows through actual generator; malformed references get one bounded ID repair, never approval',async()=>{
 const {script,raw}=fixture();let repairs=0,approved=false;
 const input={researchPack:{topic:'Archive',sources:[{id:'s1',title:'Archive',kind:'primary' as const}],openQuestions:[]},referenceContract:'catalog-v1' as const,mode:'curiosity_documentary' as const,targetDurationSeconds:180,parse:async()=>script,review:async({prompt}:{prompt:string})=>{assert.ok(JSON.parse(prompt).narrationExcerpts.length);return raw;},repairEvidence:async()=>{repairs++;return {};},onEditorialApproved:()=>{approved=true;}};
 await generateDocumentaryScript(input);assert.equal(approved,true);assert.equal(repairs,0);
 approved=false;const invalid=structuredClone(raw);invalid.sections[0].excerptId='invented';
 // One bounded ID re-selection; an empty/invalid answer keeps it stopped and unapproved.
 await assert.rejects(generateDocumentaryScript({...input,review:async()=>invalid}));assert.equal(approved,false);assert.equal(repairs,1);
});

test('real SDK completes writer, referenced critic and every visual block with no paid/network calls',async()=>{
 const oldKey=process.env.ANTHROPIC_API_KEY,oldFetch=globalThis.fetch;
 process.env.ANTHROPIC_API_KEY='offline-catalog-fixture';
 const {script,raw}=fixture();let requests=0,approved=false;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));requests++;
  assert.equal(body.output_config?.format,undefined);assert.ok(requests<=7);
  let data:unknown=script;
  if(requests===2){const prompt=JSON.parse(body.messages[0].content);assert.ok(prompt.narrationExcerpts.length);data=raw;}
  if(requests>2){const prompt=JSON.parse(body.messages[0].content),index=requests-3;assert.ok(prompt.narrationExcerpts.every((e:{beatIndex:number})=>e.beatIndex===index));
   data={visuals:script.beats[index].visuals.map(({quote,...v},i)=>({...v,excerptId:prompt.narrationExcerpts[i].id}))};}
  return new Response(JSON.stringify({id:'msg_fixture',type:'message',role:'assistant',model:body.model,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(data)}],usage:{input_tokens:10,output_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const beats=await generateDocumentaryScript({researchPack:{topic:'Archive',sources:[{id:'s1',title:'Archive',kind:'primary'}],openQuestions:[]},referenceContract:'catalog-v1',mode:'curiosity_documentary',targetDurationSeconds:180,onEditorialApproved:()=>{approved=true;}});
  assert.equal(requests,7);assert.equal(approved,true);assert.equal(beats.length,5);
  for(const b of DocumentaryScriptSchema.parse({...script,beats}).beats)for(const v of b.visuals)assert.ok(b.narration.includes(v.quote));
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=oldKey;}
});
