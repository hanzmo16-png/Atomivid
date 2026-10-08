import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorialFixture, passingReview } from './editorial.test-fixtures';
import { narrationCatalog } from './narration-catalog';
import { editorialBlockers, validateEditorialReview, EditorialTimingEvidenceError } from './editorial';
import { openingEvidence, validateOrRepairOpeningReview } from './editorial-opening-repair';
import { stableHash } from '@/lib/production-intelligence/canonical';
function fixture() {
 const script=editorialFixture();script.beats[0].narration=Array.from({length:207},(_,i)=>`word${i+1}`).join(' ');
 const catalog=narrationCatalog(script.beats), late=catalog.find(e=>e.id.endsWith(':b0:w144'))!;
 const raw={...passingReview(script),sections:script.beats.map((_,i)=>({excerptId:catalog.find(e=>e.beatIndex===i)!.id,contribution:`information ${i}`,function:i===4?'resolution':'new_information'})),
 firstAnswer:{delivered:true,evidence:{excerptId:late.id},explanation:'Delivered in the first block'},ending:{resolvesPromise:true,evidence:{excerptId:catalog.find(e=>e.beatIndex===4)!.id},explanation:'Answer in the close'}};
 return {script,raw,late,catalog};
}
const response=(firstAnswer:unknown)=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({firstAnswer})}]});
test('145–156 excerpt remains invalid; eligible catalog ends at or before 150',()=>{
 const {script,late}=fixture();assert(!openingEvidence(script.beats).some(e=>e.id===late.id));
 const review=passingReview(script);review.firstAnswer.evidence={beatIndex:0,quote:late.quote};assert.throws(()=>validateEditorialReview(review,script),EditorialTimingEvidenceError);
});
test('one bounded model check replaces only firstAnswer, preserves all findings and original',async()=>{
 const {script,raw}=fixture(), before=structuredClone(raw), ev=openingEvidence(script.beats)[0];let calls=0;
 const result=await validateOrRepairOpeningReview({rawReview:raw,script,model:'claude-sonnet-5',send:async p=>{calls++;assert.equal(p.max_tokens,800);return response({delivered:true,evidence:{excerptId:ev.id},explanation:'Concrete early answer'});}});
 assert.equal(calls,1);assert.deepEqual(raw,before);assert.deepEqual(result.findings,raw.findings);assert.equal(result.firstAnswer.evidence.quote,ev.quote);
});
test('no payoff is an editorial blocker, never an automatic approval',async()=>{
 const {script,raw}=fixture();const result=await validateOrRepairOpeningReview({rawReview:raw,script,model:'test',send:async()=>response({delivered:false,evidence:{excerptId:openingEvidence(script.beats)[0].id},explanation:'Only suspense'})});assert(editorialBlockers(result).length>0);
});
test('late or invented evidence and attempts to change other fields fail',async()=>{
 const {script,raw,late}=fixture();
 for(const id of [late.id,'invented']) await assert.rejects(validateOrRepairOpeningReview({rawReview:raw,script,model:'test',send:async()=>response({delivered:true,evidence:{excerptId:id},explanation:'test'})}));
 await assert.rejects(validateOrRepairOpeningReview({rawReview:raw,script,model:'test',send:async()=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({firstAnswer:{delivered:true,evidence:{excerptId:openingEvidence(script.beats)[0].id},explanation:'test'},findings:[]})}]})}));
});
test('other review errors do not trigger this repair',async()=>{
 const {script,raw}=fixture();raw.sections[0].excerptId='missing';let calls=0;await assert.rejects(validateOrRepairOpeningReview({rawReview:raw,script,model:'test',send:async()=>{calls++;return response({});}}));assert.equal(calls,0);
});
test('resume produces same request key and reuses cached repair',async()=>{
 const {script,raw}=fixture(), cache=new Map<string,ReturnType<typeof response>>();let paid=0;
 const send=async(p:{model:string;max_tokens:number}&Record<string,unknown>)=>{const k=stableHash(p,16);if(!cache.has(k)){paid++;cache.set(k,response({delivered:true,evidence:{excerptId:openingEvidence(script.beats)[0].id},explanation:'Early answer'}));}return cache.get(k)!;};
 await validateOrRepairOpeningReview({rawReview:raw,script,model:'test',send});await validateOrRepairOpeningReview({rawReview:raw,script,model:'test',send});assert.equal(paid,1);
});
