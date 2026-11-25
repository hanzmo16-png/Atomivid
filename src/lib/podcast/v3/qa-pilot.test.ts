import test from "node:test";
import assert from "node:assert/strict";
import { studioQaPilot } from "./qa-pilot";
import { studioGenerationEnabled, studioFlag } from "./studio";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { studioWorkerEnabled } from "../../../../scripts/podcast-3-0/studio-worker";
import { askAppIsStudioQaPilot, askAppIsStudioOwner, askAppIsInternalOwner } from "./owner-check";
const qa = { id: "11111111-2222-4333-8444-555555555555", email_confirmed_at: "2026-01-01T00:00:00Z" };
const other = { ...qa, id: "99999999-2222-4333-8444-555555555555" };
test("authorized QA pilot grants one confirmed account without global or owner privileges", () => {
  const env = { BETA_QA_USER_IDS: qa.id };
  assert.equal(studioQaPilot(qa,env),true);
  assert.equal(studioGenerationEnabled(qa,env),true);
  assert.equal(studioFlag(env,qa).source,"qa");
  assert.equal(isInternalProductionOwner(qa,env),false);
  assert.equal(studioGenerationEnabled(other,env),false);
  assert.equal(studioFlag(env,other).enabled,false);
});
test("missing, malformed, multiple, disabled and unconfirmed QA fail closed", () => {
  for(const env of [{},{BETA_QA_USER_IDS:"invalid"},{BETA_QA_USER_IDS:`${qa.id},invalid`},{BETA_QA_USER_IDS:`${qa.id},${other.id}`},{BETA_QA_USER_IDS:qa.id,PODCAST_V3_QA_PILOT:"0"}]) assert.equal(studioQaPilot(qa,env),false);
  for(const user of [null,undefined,{id:qa.id},{...qa,email_confirmed_at:null},other]) assert.equal(studioQaPilot(user,{BETA_QA_USER_IDS:qa.id}),false);
});
test("Preview visibility alone still cannot authorize another account to generate", () => {
  const env = { VERCEL_ENV:"preview", BETA_QA_USER_IDS:qa.id };
  assert.equal(studioFlag(env,other).source,"preview");
  assert.equal(studioGenerationEnabled(other,env),false);
  assert.equal(studioGenerationEnabled(qa,env),true);
});
test("native admission uses the separately signed QA answer, never an owner grant", async () => {
  const episode="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",env={PODCAST_V3_OWNER_USER_ID:other.id};
  assert.equal(await studioWorkerEnabled(episode,env,{ownerOf:async()=>qa.id,askQa:async id=>id===qa.id}),true);
  assert.equal(await studioWorkerEnabled(episode,env,{ownerOf:async()=>qa.id,askQa:async()=>false}),false);
  assert.equal(await studioWorkerEnabled(episode,env,{ownerOf:async()=>qa.id,askQa:async()=>{throw Error('fixture network failure');}}),false);
  assert.equal(await studioWorkerEnabled(episode,{...env,PODCAST_V3_QA_PILOT:"0"},{ownerOf:async()=>qa.id,askQa:async()=>true}),false);
});
test("QA answer is not owner/internal-owner; missing or malformed QA boolean blocks", async () => {
  const env={SUPABASE_SERVICE_ROLE_KEY:"fixture-secret-only-for-synthetic-hmac"};
  const response=(body:unknown)=>async()=>new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}});
  const fetchQa=response({qaPilot:true,owner:false,internalOwner:false});
  assert.equal(await askAppIsStudioQaPilot(qa.id,env,fetchQa),true);
  assert.equal(await askAppIsStudioOwner(qa.id,env,fetchQa),false);
  assert.equal(await askAppIsInternalOwner(qa.id,env,fetchQa),false);
  for(const body of [{owner:true},{qaPilot:"true"},{qaPilot:false},null]) assert.equal(await askAppIsStudioQaPilot(qa.id,env,response(body)),false);
});
