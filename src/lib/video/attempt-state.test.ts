import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { attemptState } from "./attempt-state";

function database() {
  const row: Record<string, unknown> = { id: "r", user_id: "owner", status: "processing", render_attempts: 1, progress_stage: "queued" };
  const client = createClient("https://database.test", "fixture-only", {global:{fetch: async(input,init)=>{
    assert.equal(init?.method,"PATCH");
    const filters = new URL(String(input)).searchParams;
    for (const field of ["id","user_id","status","render_attempts"]) assert.ok(filters.has(field), `missing fence ${field}`);
    const matches = [...filters].every(([key,value]) => key === "select" || (value === "is.null" ? row[key] === null : `eq.${row[key]}` === value));
    if (matches) Object.assign(row,JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(matches ? [{id:row.id}] : []),{status:200,headers:{"content-type":"application/json"}});
  }}});
  return {row,client};
}
test("simultaneous duplicate claims admit one worker",async()=>{
  const {client}=database();const state=attemptState(client,{requestId:"r",userId:"owner",attempt:1});
  const results=await Promise.all([state.claim("queued"),state.claim("queued")]);
  assert.equal(results.filter(Boolean).length,1);
});
test("old attempt cannot replace the new result or progress",async()=>{
  const {client,row}=database();const old=attemptState(client,{requestId:"r",userId:"owner",attempt:1});
  row.render_attempts=2;
  const result=await old.update({status:"failed",progress_stage:null}).select("id");
  assert.deepEqual(result.data,[]);assert.equal(row.status,"processing");assert.equal(row.progress_stage,"queued");
});
test("owner isolation and terminal state survive late updates",async()=>{
  const {client,row}=database();
  assert.equal(await attemptState(client,{requestId:"r",userId:"other",attempt:1}).claim("queued"),false);
  row.status="completed";
  await attemptState(client,{requestId:"r",userId:"owner",attempt:1}).update({status:"failed"}).select("id");
  assert.equal(row.status,"completed");
});
