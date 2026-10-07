import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ScriptJobCard } from "./ScriptJobCard";
const now=1791300000000;
const job={id:"test-id",topic:"Documentary",status:"running",stage:"Revisando el guion",error_message:null,request_id:"request-id",created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()};
test("running and failed preparations remain visible without a media/generate retry button",()=>{
 for(const state of [job,{...job,status:"failed",error_message:"Respuesta incompleta"}]) {
  const html=renderToStaticMarkup(<ScriptJobCard job={state} nowMs={now}/>);
  assert.ok(html.includes("Documentary"));assert.ok(!html.includes("Iniciar producción"));assert.ok(!html.includes("Reactivar trabajo guardado"));
 }
 const html=renderToStaticMarkup(<ScriptJobCard job={job} nowMs={now+600001}/>);
 assert.ok(html.includes("Interrumpido"));assert.ok(html.includes("no confirmó su resultado"));
 const failed=renderToStaticMarkup(<ScriptJobCard job={{...job,status:"failed",failure_kind:"editorial",error_message:"Objeción"}} nowMs={now}/>);
 assert.ok(failed.includes("Objeción editorial"));assert.ok(failed.includes("Pedir otra corrección editorial"));
});
test("completed preparation offers only the approved production configuration link",()=>{
 const html=renderToStaticMarkup(<ScriptJobCard job={{...job,status:"completed"}} nowMs={now}/>);
 assert.ok(html.includes("/dashboard/long-form/configure/request-id"));assert.ok(!html.includes("/render"));
});
