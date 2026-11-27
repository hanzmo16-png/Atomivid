import test from "node:test";
import assert from "node:assert/strict";
import { readSentinelReadiness } from "./sentinel-readiness";
const env={ACTIONS_ID_TOKEN_REQUEST_URL:"https://run-actions-1.actions.githubusercontent.com/token",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"runner-private",MS_TARGET_URL:"https://atomivid.vercel.app"};
test("OIDC reader only contacts token endpoint and exact app; no token escapes to returned evidence",async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const fetcher=(async(url:unknown,init?:RequestInit)=>{calls.push({url:String(url),init});return calls.length===1?Response.json({value:"a".repeat(30)}):Response.json({version:"resource-sentinel-readiness/1"});}) as typeof fetch;
 const result=await readSentinelReadiness(env,fetcher);
 assert.equal(calls.length,2);assert.equal(new URL(calls[0].url).searchParams.get("audience"),"atomivid-sentinel-readiness");
 assert.equal(calls[1].url,"https://atomivid.vercel.app/api/mystery-shopper/resource-readiness");
 assert.equal(calls[0].init!.redirect,"error");assert.equal(calls[1].init!.redirect,"error");
 assert.doesNotMatch(JSON.stringify(result),/runner-private|aaaaaaaaaaaaaaaa/);
});
test("missing bindings, local fixture, malicious URLs and transport errors fail closed without credential disclosure",async()=>{
 let calls=0;const fetcher=(async()=>{calls++;throw Error("private-error");}) as typeof fetch;
 for(const patch of [{ACTIONS_ID_TOKEN_REQUEST_URL:"https://evil.test/token"},{ACTIONS_ID_TOKEN_REQUEST_URL:"https://actions.githubusercontent.com.evil.test"},{MS_TARGET_URL:"https://evil.test"},{AQL_FIXTURE:"1"},{ACTIONS_ID_TOKEN_REQUEST_TOKEN:""}])
  assert.deepEqual(await readSentinelReadiness({...env,...patch},fetcher),{status:0,data:null});
 assert.equal(calls,0);assert.deepEqual(await readSentinelReadiness(env,fetcher),{status:0,data:null});assert.equal(calls,1);
});
