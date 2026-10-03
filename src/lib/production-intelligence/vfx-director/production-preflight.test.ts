import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignGenerationQuote,assertProductionConnections,VFX_GENERATION_QUOTE} from './production-preflight';
test('quote reserves generated seconds for both attempts, not the shorter edit windows',()=>{
 const q=campaignGenerationQuote(); assert.equal(q.totalUsd,4.77); assert.equal(q.calls,9);
 assert.equal(q.entries.filter(e=>e.maximumSeconds===6).length,6);
 assert.deepEqual(q.entries.filter(e=>e.stage==='plate-final').map(e=>e.usd),[1.02,1.02,1.02]);
 assert.equal(VFX_GENERATION_QUOTE.preview.audio,false);
 assert.equal(VFX_GENERATION_QUOTE.final.audio,false);
});
test('reachable docs or HTTPS alone never authorize production',()=>{
 const good={dns:true,https:true,authenticated:true,creditsVerified:true};
 for(const name of ['dns','https','authenticated','creditsVerified'] as const) {
  assert.throws(()=>assertProductionConnections([{provider:'bfl',...good},{provider:'ltx',...good,[name]:false}]),/NOT_VERIFIED/);
 }
 assert.throws(()=>assertProductionConnections([]),/NOT_VERIFIED/);
 assert.doesNotThrow(()=>assertProductionConnections([{provider:'bfl',...good},{provider:'ltx',...good}]));
});
