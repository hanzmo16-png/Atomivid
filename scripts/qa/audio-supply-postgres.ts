/** Real PostgreSQL transactions and races, no provider or remote database. */
import assert from "node:assert/strict";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { audioContract, audioDemand } from "../../src/lib/audio-studio/paid-supply-port";
import { applyInput, newProject } from "../../src/lib/audio-studio/model";
async function main(){
const db=new Client();await db.connect();let count=0;
async function check(name:string,fn:()=>Promise<void>){await fn();console.log(`PASS ${++count} ${name}`);}
const ownerId="11111111-1111-4111-8111-111111111111",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let p=applyInput(newProject({ownerId,id,now:new Date().toISOString(),voiceCount:1}),{script:"Prueba de contrato financiero."},new Date().toISOString());
p={...p,generation:{...p.generation,authorization:{usd:.1,revision:p.revision,model:p.ttsModel,at:new Date().toISOString(),spentBefore:0}}};
const c=audioContract(p),d=audioDemand(p,"a".repeat(64),10,.01),e=audioDemand(p,"b".repeat(64),10,.01);
const reserve=async(ref=c.ref,facts=c.facts,manifest=[d,e])=>(await db.query('select public.pi_reserve_audio_supply($1,$2,$3,$4) as r',[ref,facts,JSON.stringify(manifest),{spentUsd:0,calls:0,characters:0}])).rows[0].r;
const submit=async(client:Client,key:string,units=10)=>(await client.query('select public.pi_submit_with_supply($1,$2) as r',[key,units])).rows[0].r;
const insert=async(key:string,segment:string,usd=.01)=>db.query(`insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,capacity_units,status) values($1,$2,$3,'elevenlabs',$4,'audio_studio_tts_tariff_estimate','initial',$5,10,'RESERVED')`,[key,c.root,segment,p.ttsModel,usd]);
try {
 await check("closed policy makes no reservation or registry",async()=>{assert.equal((await reserve()).reserved,false);assert.equal((await db.query('select count(*) from public.pi_audio_supply_authorizations')).rows[0].count,'0');});
 await db.query(`update public.pi_supply_policies set enabled=true,baseline=100000,unit_cost_usd=.001,daily_cap_usd=100,monthly_cap_usd=100,max_concurrent=10,max_daily_calls=1000,evidence='isolated synthetic test only' where provider in ('__global__','elevenlabs')`);
 await db.query(`insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at) values('elevenlabs','character',100000,0,0,'OK','provider_api','GREEN',clock_timestamp())`);
 await db.query('set role service_role');
 await check("Audio reserves complete job without video_requests or a second ledger",async()=>{assert.equal((await reserve()).reserved,true);const r=(await db.query('select * from public.pi_supply_job_reservations where project_id=$1',[c.root])).rows;assert.equal(r.length,1);assert.equal(Number(r[0].reserved_usd),.02);assert.equal(Number(r[0].reserved_units),20);});
 await check("resume is idempotent and may supply a subset, not raised demand",async()=>{assert.equal((await reserve(c.ref,c.facts,[d])).reserved,true);assert.equal((await reserve(c.ref,c.facts,[{...d,usd:.02}])).reserved,false);});
 await check("malformed, duplicate and over-budget manifests cannot reserve",async()=>{
  await assert.rejects(reserve(c.ref,c.facts,[d,d]),/duplicate/);
  assert.equal((await reserve('f'.repeat(64),{...c.facts,projectId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},[{...d,usd:.06},{...e,usd:.06}])).reserved,false);
  await assert.rejects(reserve('f'.repeat(64),{...c.facts,usd:NaN} as typeof c.facts),/invalid/);
 });
 await check("missing legacy baseline cannot reset recorded spend or counters",async()=>{
  await assert.rejects(db.query('select public.pi_reserve_audio_supply($1,$2,$3,$4)',['f'.repeat(64),c.facts,JSON.stringify([d]),{}]),/legacy baseline/);
 });
 await check("two different Audio projects race against one global funded ceiling",async()=>{
  await db.query("update public.pi_supply_policies set daily_cap_usd=.035 where provider='__global__'");
  const a=new Client(),b=new Client();await Promise.all([a.connect(),b.connect()]);
  try {
   await Promise.all([a.query('set role service_role'),b.query('set role service_role')]);
   const results=await Promise.all([a,b].map(async(client,i)=>(await client.query('select public.pi_reserve_audio_supply($1,$2,$3,$4) as r',[(i?'c':'b').repeat(64),{...c.facts,projectId:i?'cccccccc-cccc-4ccc-8ccc-cccccccccccc':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},JSON.stringify([d]),{spentUsd:0,calls:0,characters:0}])).rows[0].r));
   assert.equal(results.filter(r=>r.reserved===true).length,1);
   assert.equal(Number((await db.query("select public.pi_supply_spend(null,date_trunc('day',clock_timestamp())) as spend")).rows[0].spend),.03);
  } finally {await Promise.all([a.end(),b.end()]);}
  await db.query("update public.pi_supply_policies set daily_cap_usd=100 where provider='__global__'");
 });
 await check("authorization is immutable and clients have no execute/table privileges",async()=>{
  await assert.rejects(db.query("update public.pi_audio_supply_authorizations set facts=facts||'{\"usd\":20}'::jsonb"),/immutable/);
  for(const role of ['anon','authenticated']){const r=await db.query("select has_function_privilege($1,'public.pi_reserve_audio_supply(text,jsonb,jsonb,jsonb)','execute') as f, has_table_privilege($1,'public.pi_audio_supply_authorizations','select') as t",[role]);assert.equal(r.rows[0].f,false);assert.equal(r.rows[0].t,false);}
 });
 await check("unmanifested, changed-price and wrong-unit submissions are refused",async()=>{await insert('audio_'+'c'.repeat(64),d.segment);assert.equal((await submit(db,'audio_'+'c'.repeat(64))).submitted,false);await insert(d.key,d.segment);assert.equal((await submit(db,d.key,11)).submitted,false);});
 await check("concurrent independent connections admit one call and consume envelope once",async()=>{
  const a=new Client(),b=new Client();await Promise.all([a.connect(),b.connect()]);
  try {await Promise.all([a.query('set role service_role'),b.query('set role service_role')]);const results=await Promise.all([submit(a,d.key),submit(b,d.key)]);assert.equal(results.filter(r=>r.submitted===true).length,1);}finally{await Promise.all([a.end(),b.end()]);}
  const row=(await db.query('select consumed_usd,consumed_units from public.pi_supply_job_reservations where project_id=$1',[c.root])).rows[0];assert.equal(Number(row.consumed_usd),.01);assert.equal(Number(row.consumed_units),10);
 });
 await check("uncertain send blocks reauthorization; original authorization/unused hold survive",async()=>{assert.equal((await reserve('d'.repeat(64),{...c.facts,at:new Date(Date.now()+1000).toISOString()},[e])).reserved,false);assert.equal((await db.query("select count(*) from public.pi_audio_supply_authorizations where status='ACTIVE' and project_key=$1",[c.root])).rows[0].count,'1');});
 await db.query("update public.pi_paid_operations set status='PROVIDER_JOB_RECORDED',committed_usd=.01,result_ref='offline receipt' where idempotency_key=$1",[d.key]);
 await db.query("update public.pi_paid_operations set status='COMMITTED' where idempotency_key=$1",[d.key]);
 await check("journal usage is authoritative and counts tariff estimate once",async()=>{const r=(await db.query('select public.pi_audio_supply_usage($1) as r',[c.root])).rows[0].r;assert.equal(r.spentUsd,.01);assert.equal(r.calls,1);assert.equal(r.characters,10);});
 await check("lost committed cache cannot be paid again under a new authorization",async()=>{assert.equal((await reserve('e'.repeat(64),{...c.facts,at:new Date(Date.now()+2000).toISOString()},[d])).reserved,false);});
 await check("existing Reel/recovery/authorization guards remain in the preserved chain",async()=>{const rows=(await db.query("select proname,prosrc from pg_proc where proname in ('submit_before_audio','pi_submit_with_supply_pre_authz','pi_submit_with_supply_core')")).rows;assert.ok(rows.some(r=>r.prosrc.includes('authorization missing')));assert.ok(rows.some(r=>r.prosrc.includes('reel budget exceeded')));assert.ok(rows.some(r=>r.prosrc.includes('recovery')));});
 await check("rollback preserves all financial history and blocks new Audio submissions",async()=>{
  const before=(await db.query("select md5(prosrc) as hash from pg_proc where proname='submit_before_audio'")).rows[0].hash;
  await insert(e.key,e.segment);
  const rowsBefore=(await db.query('select count(*) from public.pi_paid_operations')).rows[0].count;
  await db.query('reset role');
  await db.query(await readFile(path.join(process.cwd(),'supabase/proposals/20261127050646_audio_supply_authorization_contract.rollback.sql'),'utf8'));
  await db.query('set role service_role');
  assert.match((await submit(db,e.key)).reason,/rolled back/);
  assert.equal((await db.query('select count(*) from public.pi_paid_operations')).rows[0].count,rowsBefore);
  assert.equal((await db.query("select md5(prosrc) as hash from pg_proc where proname='submit_before_audio'")).rows[0].hash,before);
  await assert.rejects(reserve(),/permission denied/);
 });
 console.log(`RESULT audio-supply-postgres: ${count} PASS, 0 FAIL; PostgreSQL actual, provider calls 0`);
} finally {await db.end();}

}
main().catch(error=>{console.error(error);process.exitCode=1;});
