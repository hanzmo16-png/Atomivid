import test from 'node:test';import assert from 'node:assert/strict';
import {normalUsage,quotaExpectation,quotaNoteMatches,readQuotaRows} from './live-quota-oracle.mjs';
const now='2026-11-26T16:00:00Z';
const row=(id,extra={})=>({id,mode:'visual',status:'completed',render_started_at:null,created_at:'2026-11-01T00:00:00Z',...extra});
test('independent UTC cutoff, render-start fallback, statuses, SQL null/avatars, future lower-bound semantics',()=>{
  const rows=[row('exact'),row('prior',{created_at:'2026-10-31T23:59:59Z'}),row('old-draft-new-render',{created_at:'2026-01-01T00:00:00Z',render_started_at:'2026-11-03T00:00:00Z'}),row('new-draft-old-render',{render_started_at:'2026-10-31T23:59:59Z'}),row('avatar',{mode:'avatar'}),row('null',{mode:null}),row('draft',{status:'draft'}),row('processing',{status:'processing'}),row('future',{created_at:'2026-12-01T00:00:00Z'}),row('offset-prior',{created_at:'2026-11-01T00:30:00+01:00'}),row('offset-current',{created_at:'2026-10-31T23:30:00-01:00'})];
  assert.deepEqual(normalUsage(rows,now),{used:5,cutoff:'2026-11-01T00:00:00.000Z'});
  assert.throws(()=>normalUsage([row('invalid',{render_started_at:'not-date'})],now));
  assert.throws(()=>normalUsage([row('invalid',{created_at:'2026-02-30T00:00:00Z'})],now));
  assert.throws(()=>normalUsage([row('duplicate'),row('duplicate')],now));
});
test('visible live plan oracle validates correct count and rejects false quota/plan assumptions',()=>{
  const p=quotaExpectation({ownerVisible:false,status:'active',planLabel:'Atomicvid',used:3});
  assert.deepEqual(p,{kind:'plan',planName:'Starter',used:3,limit:15,remaining:12});
  assert.ok(quotaNoteMatches(p,true,'Tu plan Starter: te quedan 12 de 15 videos este mes.'));
  assert.equal(quotaNoteMatches(p,true,'Tu plan Starter: te quedan 13 de 15 videos este mes.'),false);
  assert.equal(quotaNoteMatches(p,false),false);
  assert.equal(quotaNoteMatches(p,true,'Tu plan Pro: te quedan 12 de 15 videos este mes.'),false);
  const full=quotaExpectation({ownerVisible:false,status:'trialing',planLabel:'Atomicvid Pro',used:31});
  assert.ok(quotaNoteMatches(full,true,'Tu plan Pro: ya usaste los 30 videos de este mes.'));
  assert.equal(quotaExpectation({ownerVisible:false,status:'active',planLabel:'Atomicvid Business',used:0}).limit,60);
  assert.ok(quotaNoteMatches(quotaExpectation({ownerVisible:true,status:'active',used:3}),false));
  assert.ok(quotaNoteMatches(quotaExpectation({ownerVisible:false,status:'canceled',used:3}),true,'Necesitas una suscripción activa para generar videos.'));
});
test('fails closed on partial pagination rather than inventing remaining quota',async()=>{
  const q={select(){return this},eq(){return this},order(){return this},range(){return Promise.resolve({data:[row('one')],count:2,error:null})}};
  await assert.rejects(readQuotaRows({from(){return q}},'owner'));
});
