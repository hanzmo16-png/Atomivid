import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { attemptState } from "./attempt-state";

// Hermético: claim() elige la ruta según el entorno (isProductionRuntime || SUPPLY_GUARD_ENFORCED). Sin fijarlo, una
// shell con NODE_ENV=production, VERCEL=1, ATOMIVID_RUNTIME=production o SUPPLY_GUARD_ENFORCED=true (p. ej. tras el
// arnés o `next build`) desvía estas pruebas a la RPC pi_claim_render_supply, que este doble no simula.
const GUARD_ENV = ["NODE_ENV", "VERCEL", "ATOMIVID_RUNTIME", "SUPPLY_GUARD_ENFORCED"] as const;
function withEnv(values: Partial<Record<(typeof GUARD_ENV)[number], string>>) {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.fromEntries(GUARD_ENV.map((k) => [k, process.env[k]]));
  for (const k of GUARD_ENV) delete env[k];
  Object.assign(env, values);
  return () => { for (const k of GUARD_ENV) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; } };
}
let restoreEnv = () => {};
test.beforeEach(() => { restoreEnv = withEnv({ NODE_ENV: "test" }); });
test.afterEach(() => restoreEnv());

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

test("con el guardián de suministro activo, claim usa SOLO la RPC con dueño e intento, y un error es visible",async()=>{
  restoreEnv(); restoreEnv = withEnv({ NODE_ENV: "test", SUPPLY_GUARD_ENFORCED: "true" });
  const calls: Array<{url:string;body:unknown}> = [];
  let reply: {status:number;body:unknown} = {status:200,body:{claimed:true}};
  const client = createClient("https://database.test", "fixture-only", {global:{fetch: async(input,init)=>{
    calls.push({url:String(input),body:JSON.parse(String(init?.body ?? "null"))});
    return new Response(JSON.stringify(reply.body),{status:reply.status,headers:{"content-type":"application/json"}});
  }}});
  const state=attemptState(client,{requestId:"r",userId:"owner",attempt:3});
  assert.equal(await state.claim("queued"),true);
  assert.equal(calls.length,1); assert.match(calls[0].url,/\/rpc\/pi_claim_render_supply$/);
  assert.deepEqual(calls[0].body,{p_request_id:"r",p_owner_id:"owner",p_attempt:3});
  reply={status:200,body:{claimed:false}}; assert.equal(await state.claim("queued"),false);
  reply={status:500,body:{message:"boom"}}; await assert.rejects(state.claim("queued"),/No se pudo verificar el cupo/);
  assert.equal(await state.claim("voice"),false); assert.equal(calls.length,3);
});
