import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { qualityReadinessResponse, SENTINEL_READINESS_POLICY as policy } from "./quality-readiness";
import { sentinelStatus, providerReadiness } from "../mystery-shopper/quality-loop/policy";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const nowS=Math.floor(Date.now()/1000);
const jwks=async()=>({keys:[{...publicKey.export({format:"jwk"}),kid:"test",kty:"RSA"}]});
function jwt(patch:Record<string,unknown>={}) {
 const h=Buffer.from(JSON.stringify({alg:"RS256",kid:"test"})).toString("base64url");
 const c=Buffer.from(JSON.stringify({iss:"https://token.actions.githubusercontent.com",aud:policy.audience,exp:nowS+300,iat:nowS,repository:policy.repository,ref:`refs/heads/${policy.defaultBranch}`,environment:"Preview",event_name:"schedule",workflow_ref:`${policy.repository}/.github/workflows/mystery-shopper.yml@refs/heads/${policy.defaultBranch}`,run_id:"123",...patch})).toString("base64url");
 return `${h}.${c}.${sign("RSA-SHA256",Buffer.from(`${h}.${c}`),privateKey).toString("base64url")}`;
}
const request=(token?:string)=>new Request("https://atomivid.vercel.app/api/mystery-shopper/resource-readiness",{headers:token?{authorization:`Bearer ${token}`}:{}});
test("machine authentication rejects absent, wrong workflow/branch/environment/audience, PR and expired tokens before constructing privileged reader",async()=>{
 let reads=0;const read=async()=>{reads++;throw Error("must not read");};
 assert.equal((await qualityReadinessResponse(request(),{read,jwks,nowS})).status,401);
 for(const patch of [{aud:"atomivid-drive-token"},{environment:"orchestrator"},{ref:"refs/heads/other"},{event_name:"pull_request"},{workflow_ref:"other"},{repository:"other/repo"},{exp:nowS-100},{job_workflow_ref:"other"}])
  assert.equal((await qualityReadinessResponse(request(jwt(patch)),{read,jwks,nowS})).status,403);
 assert.equal(reads,0);
});
test("authenticated machine DTO omits every amount, private operation and identity, preserves unknown and does not authorize generation",async()=>{
 const observation={observedAt:new Date().toISOString(),sentinel:{accounts:[{providers:["elevenlabs"],operationalLevel:"GRAY",balanceStatus:"REAL",free:123456}],resources:[]},admission:[],privatePayload:"not-exported",timezones:[],coverage:{}};
 const response=await qualityReadinessResponse(request(jwt()),{read:async()=>observation as never,jwks,nowS});
 assert.equal(response.status,200);assert.match(response.headers.get("cache-control")!,/no-store/);
 const dto=await response.json();assert.equal(sentinelStatus(200,dto),"READ");
 assert.deepEqual(Object.keys(dto.products),["youtube","reels","audio-podcast","video-podcast"]);
 for(const product of Object.keys(dto.products))assert.equal(providerReadiness(product as "youtube",dto),false);
 assert.doesNotMatch(JSON.stringify(dto),/123456|free|privatePayload|balanceStatus|accounts|admission|elevenlabs/);
 assert.equal(sentinelStatus(200,{...dto,observedAt:new Date(Date.now()-300001).toISOString()}),"BLOCKED");
 assert.equal(sentinelStatus(200,{...dto,products:{youtube:{ready:true}}}),"BLOCKED");
});
test("reader errors disclose no credentials or financial payload",async()=>{
 const response=await qualityReadinessResponse(request(jwt()),{read:async()=>{throw Error("SECRET balance=999");},jwks,nowS});
 assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/SECRET|999/);
});
