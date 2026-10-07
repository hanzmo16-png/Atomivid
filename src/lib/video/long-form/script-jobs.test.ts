import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptJobSignature, validScriptJobSignature } from "./script-job-auth";
import { scriptJobView, ScriptJobFieldsSchema } from "./script-job-types";
const id="11111111-1111-4111-8111-111111111111",key="test-secret-".repeat(4),now=1791300000000;
test("worker signature is bound to the job, time and secret; replay outside window fails",()=>{
 const time=String(now),signature=scriptJobSignature(key,id,time);
 assert.equal(validScriptJobSignature(key,id,time,signature,now),true);
 assert.equal(validScriptJobSignature(key,id,time,signature,now+300001),false);
 assert.equal(validScriptJobSignature(key,id.replace(/^1/,"2"),time,signature,now),false);
 assert.equal(validScriptJobSignature("other-secret".repeat(4),id,time,signature,now),false);
 assert.equal(validScriptJobSignature(undefined,id,time,signature,now),false);
});
test("in-progress jobs stay visible; abandoned workers never advertise success or a paid retry",()=>{
 const job={id,topic:"Test",status:"running",stage:"Escribiendo",error_message:null,request_id:id,created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()};
 assert.equal(scriptJobView(job,now).refresh,true);
 assert.equal(scriptJobView(job,now+360001).refresh,true);
 assert.equal(scriptJobView(job,now+600001).label,"Interrumpido");
 assert.equal(scriptJobView({...job,status:"failed",error_message:"Stopped"},now).label,"Fallo técnico");
 assert.equal(scriptJobView({...job,status:"failed",error_message:"Stopped"},now).message,"Stopped");
});
test("saved inputs are bounded before enqueue, including language and references",()=>{
 const fields={topic:"Documentary",durationMinutes:"7",sources:"",openQuestions:"",language:"en"};
 assert.equal(ScriptJobFieldsSchema.safeParse(fields).success,true);
 for(const patch of [{durationMinutes:"NaN"},{durationMinutes:"16"},{language:"fr"},{sources:"x".repeat(12001)}])
  assert.equal(ScriptJobFieldsSchema.safeParse({...fields,...patch}).success,false);
});
