import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { qualityReadiness, qualityReadinessResponse, SENTINEL_READINESS_POLICY as policy, sentinelReadinessPolicy } from "./quality-readiness";
import { PRODUCT_PROVIDER_IMPACT, sentinelStatus, providerReadiness } from "../mystery-shopper/quality-loop/policy";
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
test("diagnostic codes preserve the exact existing readiness predicate for every product and anomalous observation",()=>{
 const providers=[...new Set(Object.values(PRODUCT_PROVIDER_IMPACT).flat())];
 const complete={observedAt:new Date().toISOString(),sentinel:{accounts:providers.map(provider=>({providers:[provider],operationalLevel:"GREEN",balanceStatus:"REAL",free:23.456,auditStatus:"VERIFIED_LEDGER_ADJUSTMENT"})),resources:[{resource:"workers",state:"VERIFIED",used:0,limit:2}]},coverage:{workers:"all verified"}};
 const products=Object.keys(PRODUCT_PROVIDER_IMPACT) as (keyof typeof PRODUCT_PROVIDER_IMPACT)[];
 for(const patch of [undefined,{balanceStatus:"UNKNOWN"},{balanceStatus:"STALE"},{balanceStatus:"ESTIMATED"},{free:null},{free:NaN},{free:Infinity},{free:-1},{free:0},{operationalLevel:"GRAY",auditStatus:"CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED"}]) {
  const observation={...complete,sentinel:{...complete.sentinel,accounts:complete.sentinel.accounts.map(a=>({...a,...patch}))}};
  const dto=qualityReadiness(observation as never);
  for(const product of products) {
   assert.equal(dto.products[product].ready,providerReadiness(product,observation));
   if(dto.products[product].ready)assert.deepEqual(dto.products[product].blockers,[]);
   else assert.ok(dto.products[product].blockers.length>0);
  }
  const wire=JSON.stringify(dto);
  for(const provider of providers)assert.ok(!wire.includes(provider),"provider identity must not leave diagnostics");
  assert.doesNotMatch(wire,/23\.456|auditStatus|accounts|operationalLevel/);
 }
});
test("missing observations and distinct balance, ledger and worker limitations remain explicit without leaking inputs",()=>{
 const observe=(patch:Record<string,unknown>)=>({observedAt:new Date().toISOString(),sentinel:{accounts:[{providers:["elevenlabs"],operationalLevel:"GRAY",balanceStatus:"UNKNOWN",free:null,auditStatus:"CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED",privateId:"DO_NOT_EXPORT",...patch}],resources:[]},coverage:{workers:"video_requests only; excludes separate Audio/Podcast workers"}});
 const codes=qualityReadiness(observe({}) as never).products["audio-podcast"].blockers;
 for(const code of ["OBSERVATION_MISSING","BALANCE_UNKNOWN","FREE_CAPACITY_UNKNOWN","CROSS_PRODUCT_LEDGER_UNVERIFIED","WORKER_CAPACITY_UNVERIFIED_OR_UNAVAILABLE","WORKER_COVERAGE_UNVERIFIED"])assert.ok(codes.includes(code),code);
 for(const [patch,code] of [[{balanceStatus:"STALE"},"BALANCE_STALE"],[{balanceStatus:"ESTIMATED"},"BALANCE_ESTIMATED"],[{free:0},"FREE_CAPACITY_NOT_POSITIVE"]] as const)assert.ok(qualityReadiness(observe(patch) as never).products["audio-podcast"].blockers.includes(code));
 const dto=qualityReadiness(observe({auditStatus:"private upstream text 999 https://private.test"}) as never);
 assert.doesNotMatch(JSON.stringify(dto),/DO_NOT_EXPORT|999|private\.test|upstream|elevenlabs/);
 assert.deepEqual(qualityReadiness(observe({}) as never).products["audio-podcast"].blockers,codes,"stable ordering");
});
test("known partial worker coverage and invalid worker telemetry never produce a ready DTO",()=>{
 const providers=[...new Set(Object.values(PRODUCT_PROVIDER_IMPACT).flat())];
 const observation={observedAt:new Date().toISOString(),sentinel:{accounts:providers.map(provider=>({providers:[provider],operationalLevel:"GREEN",balanceStatus:"REAL",free:1})),resources:[{resource:"workers",state:"VERIFIED",used:0,limit:2}]},coverage:{workers:"video_requests only; excludes separate Audio/Podcast workers"}};
 const dto=qualityReadiness(observation as never);
 for(const product of ["audio-podcast","video-podcast"]) {
  assert.equal(dto.products[product].ready,false);
  assert.deepEqual(dto.products[product].blockers,["WORKER_COVERAGE_UNVERIFIED"]);
 }
 for(const telemetry of [{used:NaN,limit:2},{used:Infinity,limit:2},{used:-1,limit:2},{used:0.5,limit:2},{used:0,limit:Infinity},{used:0,limit:-1},{used:0,limit:1.5},{used:0,limit:0}]) {
  const invalid={...observation,coverage:{workers:"all verified"},sentinel:{...observation.sentinel,resources:[{resource:"workers",state:"VERIFIED",...telemetry}]}};
  const result=qualityReadiness(invalid as never);
  for(const product of Object.keys(PRODUCT_PROVIDER_IMPACT)) {
   assert.equal(result.products[product].ready,false);
   assert.deepEqual(result.products[product].blockers,["WORKER_CAPACITY_UNVERIFIED_OR_UNAVAILABLE"]);
  }
 }
});
test("only trusted Production deployment metadata opts readiness into a valid exact commit pin",()=>{
 const sha="5d059bc13a27a3902f05f9e22fa09014b0d2adee";
 assert.equal(sentinelReadinessPolicy({VERCEL_ENV:"production",VERCEL_GIT_COMMIT_SHA:sha}).detachedDeploymentSha,sha);
 for(const env of [{},{VERCEL_ENV:"preview",VERCEL_GIT_COMMIT_SHA:sha},{VERCEL_ENV:"development",VERCEL_GIT_COMMIT_SHA:sha},{VERCEL_ENV:"production"},{VERCEL_ENV:"production",VERCEL_GIT_COMMIT_SHA:"bad"},{VERCEL_ENV:"production",VERCEL_GIT_COMMIT_SHA:sha.toUpperCase()}])
  assert.equal(sentinelReadinessPolicy(env).detachedDeploymentSha,undefined);
 assert.equal(policy.detachedDeploymentSha,undefined);
});
test("Production route validates the exact deployed commit before constructing its private reader",async()=>{
 const sha="5d059bc13a27a3902f05f9e22fa09014b0d2adee";
 const previous={environment:process.env.VERCEL_ENV,sha:process.env.VERCEL_GIT_COMMIT_SHA};let reads=0;
 process.env.VERCEL_ENV="production";process.env.VERCEL_GIT_COMMIT_SHA=sha;
 try{
  const read=async()=>{reads++;return {observedAt:new Date().toISOString(),sentinel:{accounts:[],resources:[]}} as never;};
  const claims={event_name:"deployment_status",ref:"",sha,workflow_ref:`${policy.repository}/.github/workflows/mystery-shopper.yml@${sha}`};
  const response=await qualityReadinessResponse(request(jwt(claims)),{read,jwks,nowS});
  assert.equal(response.status,200);assert.equal(reads,1);
  assert.equal((await response.json()).scope,"READ_ONLY_NOT_ATOMIC_ADMISSION");
  assert.equal((await qualityReadinessResponse(request(jwt({...claims,sha:"a".repeat(40)})),{read,jwks,nowS})).status,403);
  assert.equal(reads,1);
 }finally{
  if(previous.environment===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous.environment;
  if(previous.sha===undefined)delete process.env.VERCEL_GIT_COMMIT_SHA;else process.env.VERCEL_GIT_COMMIT_SHA=previous.sha;
 }
});
