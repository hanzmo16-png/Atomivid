import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptJobSignature, validScriptJobSignature } from "./script-job-auth";
import { scriptJobView, ScriptJobFieldsSchema, LONG_FORM_MAX_MINUTES, LONG_FORM_MIN_MINUTES } from "./script-job-types";
import { readFileSync } from "node:fs";
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
 for(const patch of [{durationMinutes:"NaN"},{durationMinutes:"2"},{durationMinutes:"31"},{language:"fr"},{sources:"x".repeat(12001)}])
  assert.equal(ScriptJobFieldsSchema.safeParse({...fields,...patch}).success,false);
});
test("incidente Anunnaki: 16–30 min se guardan (el formulario ofrece 30; antes el trabajo durable cortaba en 15)",()=>{
 const fields={topic:"¿Evolución o manipulación genética? El misterio de los Anunnaki",durationMinutes:"30",sources:"",openQuestions:"",language:"es"};
 for(const d of ["3","10","15","16","20","30"]) assert.equal(ScriptJobFieldsSchema.safeParse({...fields,durationMinutes:d}).success,true,d);
 assert.equal(ScriptJobFieldsSchema.parse(fields).durationMinutes,"30");
});
test("el rango del formulario y el del trabajo durable son el mismo",()=>{
 const actions=readFileSync("src/app/dashboard/long-form/new/actions.ts","utf8");
 assert.equal(Number(actions.match(/MAX_DURATION_MINUTES = (\d+)/)![1]),LONG_FORM_MAX_MINUTES);
 assert.equal(Number(actions.match(/MIN_DURATION_MINUTES = (\d+)/)![1]),LONG_FORM_MIN_MINUTES);
 const page=readFileSync("src/app/dashboard/long-form/new/page.tsx","utf8");
 assert.match(page,new RegExp(`min=\\{${LONG_FORM_MIN_MINUTES}\\}`)); assert.match(page,new RegExp(`max=\\{${LONG_FORM_MAX_MINUTES}\\}`));
});
