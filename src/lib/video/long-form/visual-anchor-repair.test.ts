import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVisualAnchorRepair, repairVisualAnchors } from './visual-anchor-repair';
import { narrationCatalog } from './narration-catalog';
import { stableHash } from '@/lib/production-intelligence/canonical';
const narration='A specific documentary detail anchors this visual scene without changing the approved narrative. Another fact follows in the same block.';
const catalog=narrationCatalog([{narration}]);
const raw={visuals:[{excerptId:'invalid',description:'Specific evidence',beatClass:'EVIDENCE',impact:3,impactReason:'Critical fact',evidence:{sourceIds:['source-1'],proposition:'Exact claim'}},{excerptId:'invalid-2',description:'Documentary process',beatClass:'PROCESS',impact:2,impactReason:'Explain process'}]};
const replacements=[{index:0,excerptId:catalog[0].id},{index:1,excerptId:catalog[1].id}];
const response=(value:unknown)=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}]});
test('only invalid pointers change; all scene claims and original response remain unchanged',()=>{
 const before=structuredClone(raw),fixed=applyVisualAnchorRepair(raw,catalog,[0,1],{replacements});assert.deepEqual(raw,before);
 for(let i=0;i<2;i++)assert.deepEqual({...fixed.visuals[i],excerptId:raw.visuals[i].excerptId},raw.visuals[i]);
});
test('unknown or wrong-block references, missing, extra and duplicate indices are rejected',()=>{
 for(const bad of [[replacements[0]],[...replacements,replacements[0]],[...replacements,{index:2,excerptId:catalog[0].id}],[replacements[0],{index:1,excerptId:'wrong-block'}]])assert.throws(()=>applyVisualAnchorRepair(raw,catalog,[0,1],{replacements:bad}));
 assert.throws(()=>applyVisualAnchorRepair(raw,catalog,[0,1],{replacements,visuals:[]}));
});
test('valid existing anchors never request a repair',async()=>{
 const valid=applyVisualAnchorRepair(raw,catalog,[0,1],{replacements});let calls=0;
 assert.deepEqual(await repairVisualAnchors({raw:valid,catalog,narration,model:'test',send:async()=>{calls++;return response({replacements});}}),valid);assert.equal(calls,0);
});
test('mixed anchors repair only unresolved scene and preserve the valid scene',async()=>{
 const mixed=structuredClone(raw);mixed.visuals[0].excerptId=catalog[0].id;
 const fixed=await repairVisualAnchors({raw:mixed,catalog,narration,model:'test',send:async p=>{const data=JSON.parse((p.messages as {content:string}[])[0].content);assert.deepEqual(data.targets.map((x:{index:number})=>x.index),[1]);return response({replacements:[replacements[1]]});}});
 assert.deepEqual(fixed.visuals[0],mixed.visuals[0]);
});
test('resume uses deterministic request and completed repair is paid once',async()=>{
 const cache=new Map<string,ReturnType<typeof response>>();let paid=0;
 const send=async(p:{model:string;max_tokens:number}&Record<string,unknown>)=>{const key=stableHash(p,16);assert.equal(p.max_tokens,800);if(!cache.has(key)){paid++;cache.set(key,response({replacements}));}return cache.get(key)!;};
 await repairVisualAnchors({raw,catalog,narration,model:'test',send});await repairVisualAnchors({raw,catalog,narration,model:'test',send});assert.equal(paid,1);
});
test('uncertain operation propagates without retry or changing raw plan',async()=>{
 let calls=0;const before=structuredClone(raw);await assert.rejects(repairVisualAnchors({raw,catalog,narration,model:'test',send:async()=>{calls++;throw Error('uncertain');}}));assert.equal(calls,1);assert.deepEqual(raw,before);
});
