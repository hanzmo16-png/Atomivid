import test from "node:test";
import assert from "node:assert/strict";
import { previewAccessBlocked, previewProtectionHeaders } from "../../../../scripts/mystery-shopper/preview-access";
const app="https://pinned-preview.vercel.app";
test("HTTP 200 after Vercel SSO redirect blocks before entering QA credentials",()=>{
  assert.equal(previewAccessBlocked(app,"https://vercel.com/login?next=private",200),true);
  assert.equal(previewAccessBlocked(app,app+"/login",200),false);
  for(const status of [401,403]) assert.equal(previewAccessBlocked(app,app+"/login",status),true);
  assert.equal(previewAccessBlocked(app,"not a URL",200),true);
});
test("existing bypass header never follows a redirect, asset or provider to another origin",()=>{
  const fixture="synthetic-credential";
  assert.deepEqual(previewProtectionHeaders(app,app+"/login",fixture),{"x-vercel-protection-bypass":fixture,"x-vercel-set-bypass-cookie":"true"});
  for(const url of ["https://vercel.com/login","https://api.elevenlabs.io",app+".attacker.test",app.replace("https:","http:"),"bad URL"]) assert.deepEqual(previewProtectionHeaders(app,url,fixture),{});
  assert.deepEqual(previewProtectionHeaders(app,app,undefined),{});
});
