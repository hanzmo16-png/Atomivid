import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyInspectionLoginPath, readOnlyInspectionUrl, runPageMaintenance, supportsReadOnlyInspection } from './readonly-inspection';
import { safeRedirectTarget } from '../../auth/errors';
const origin='https://atomivid.vercel.app', sha='a'.repeat(40);
test('housekeeping runs normally but its callback is never invoked in read-only observation',async()=>{
 let calls=0;const maintain=async()=>++calls;
 assert.equal(await runPageMaintenance('read-only',maintain),undefined);assert.equal(calls,0);
 for(const input of [undefined,'',true,['read-only'],'READ-ONLY']) await runPageMaintenance(input,maintain);
 assert.equal(calls,5);
});
test('inspection rewrite covers navigation/RSC/login redirect GETs only, preserves query and never expands origin',()=>{
 for(const pathname of ['/dashboard','/dashboard/videos/a-valid-or-invalid-id']) {
  const u=new URL(readOnlyInspectionUrl(origin+pathname+'?_rsc=abc&existing=1&inspection=wrong',origin,'GET')!);
  assert.equal(u.searchParams.get('inspection'),'read-only');assert.equal(u.searchParams.get('_rsc'),'abc');assert.equal(u.searchParams.get('existing'),'1');
 }
 for(const url of ['https://foreign.example/dashboard',origin+'/login',origin+'/api/generate/id/render',origin+'/dashboard/podcast']) assert.equal(readOnlyInspectionUrl(url,origin,'GET'),null);
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD'])assert.equal(readOnlyInspectionUrl(origin+'/dashboard',origin,method),null);
});
test('legacy, malformed, unknown-version or non-success capability fails closed',()=>{
 for(const body of [null,{}, {sha}, {sha,readOnlyInspectionVersion:'1'}, {sha:'unknown',readOnlyInspectionVersion:1},{sha,readOnlyInspectionVersion:2}])assert.equal(supportsReadOnlyInspection(200,body),false);
 assert.equal(supportsReadOnlyInspection(403,{sha,readOnlyInspectionVersion:1}),false);
 assert.equal(supportsReadOnlyInspection(200,{sha,readOnlyInspectionVersion:1}),true);
});

test('existing login return-target contract opts out before a Server Action internal redirect',()=>{
 const login=new URL(readOnlyInspectionLoginPath(),origin);const target=login.searchParams.get('redirectedFrom');
 assert.equal(login.pathname,'/login');assert.equal(target,'/dashboard?inspection=read-only');assert.equal(safeRedirectTarget(target),target);
});
