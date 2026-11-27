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
 const chain=(await db.query(`select n.nspname as schema,p.proname as name,
  pg_catalog.md5(p.prosrc) as source_md5,p.prosecdef as security_definer,p.proacl::text as acl
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where p.oid in (to_regprocedure('public.pi_submit_with_supply(text,numeric)'),
   to_regprocedure('pi_internal.submit_before_audio(text,numeric)'),
   to_regprocedure('public.pi_submit_with_supply_pre_authz(text,numeric)'),
   to_regprocedure('public.pi_submit_with_supply_core(text,numeric)'),
   to_regprocedure('public.pi_reserve_job_supply(uuid,integer,jsonb)')) order by n.nspname,p.proname`)).rows;
 // Fingerprints are provenance, not a manufactured equality with an unverified remote chain.
 console.log('POSTGRES_CHAIN_METADATA',JSON.stringify(chain));
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
 // The preceding text check is diagnostic only. These additional cases execute the
 // real post-Audio public wrapper, its preserved legacy chain and the supply core.
 // Synthetic rows live in rollback-only transactions in this disposable database.
 async function legacyFixture(run:()=>Promise<void>) {
  await db.query('begin');
  try {
   await db.query('reset role');
   await db.query("insert into auth.users(id,email) values($1,'audio-wrapper-fixture@example.test') on conflict do nothing",[ownerId]);
   await run();
  } finally {await db.query('rollback');}
 }
 const legacyOperation=async(key:string,project:string,usd:number,status='RESERVED')=>db.query(`
  insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,capacity_units,status)
  values($1,$2,$1,'elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$3,case when $4='COMMITTED' then $3::numeric else null end,10,$4)`,[key,project,usd,status]);
 const operationState=async(key:string)=>(await db.query('select status,supply_job_key from public.pi_paid_operations where idempotency_key=$1',[key])).rows[0];
 const supplySpend=async()=>Number((await db.query("select public.pi_supply_spend(null,date_trunc('day',clock_timestamp())) as spend")).rows[0].spend);
 const reelFixture=async(id:string,cap:number)=>db.query(`insert into public.video_requests
  (id,user_id,topic,style,duration_seconds,status,render_attempts,mode,provider_spend_cap_usd)
  values($1,$2,'Offline post-Audio wrapper fixture','documental',30,'processing',1,'visual',$3)`,[id,ownerId,cap]);
 await check("runtime non-Audio Reel admits once, transfers one envelope and releases only unused capacity",async()=>legacyFixture(async()=>{
  const reel='dddddddd-dddd-4ddd-8ddd-dddddddddddd',key='legacy_runtime_reel_once';
  await reelFixture(reel,.05);
  await db.query('set local role service_role');
  const before=await supplySpend();
  const reserved=(await db.query('select public.pi_reserve_job_supply($1,1,$2) as r',[reel,JSON.stringify([{provider:'elevenlabs',unit:'character',units:20,usd:.02}])])).rows[0].r;
  assert.equal(reserved.reserved,true);
  assert.ok(Math.abs(await supplySpend()-before-.02)<1e-9,'one whole-job envelope counts once');
  await legacyOperation(key,reel,.01);
  assert.equal((await submit(db,key,10)).submitted,true);
  assert.equal((await submit(db,key,10)).submitted,false,'replaying the same operation cannot admit twice');
  const row=await operationState(key);
  assert.equal(row.status,'SUBMITTED');assert.equal(row.supply_job_key,`job:${reel}:1:elevenlabs`);
  const hold=(await db.query('select consumed_units,consumed_usd from public.pi_supply_job_reservations where id=$1',[row.supply_job_key])).rows[0];
  assert.equal(Number(hold.consumed_units),10);assert.equal(Number(hold.consumed_usd),.01);
  assert.ok(Math.abs(await supplySpend()-before-.02)<1e-9,'ledger admission replaces envelope usage, not another charge');
  await db.query('select public.pi_release_job_supply($1,1)',[reel]);
  assert.ok(Math.abs(await supplySpend()-before-.01)<1e-9,'release preserves the submitted amount and frees only unused capacity');
  assert.equal((await operationState(key)).status,'SUBMITTED');
 }));
 await check("runtime non-Audio Podcast without authorization remains RESERVED without consuming supply",async()=>legacyFixture(async()=>{
  const key='legacy_runtime_podcast_noauth';
  await legacyOperation(key,'podcast-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',.01);
  await db.query('set local role service_role');
  const before=await supplySpend();
  const result=await submit(db,key,10);
  assert.equal(result.submitted,false);assert.equal(result.reason,'authorization missing');
  assert.deepEqual(await operationState(key),{status:'RESERVED',supply_job_key:null});
  assert.equal(await supplySpend(),before);
 }));
 await check("runtime non-Audio Reel cap still counts committed and uncertain calls before admission",async()=>legacyFixture(async()=>{
  const reel='ffffffff-ffff-4fff-8fff-ffffffffffff',key='legacy_runtime_reel_exceeded';
  await reelFixture(reel,.01);
  await legacyOperation('legacy_runtime_reel_paid',reel,.005,'COMMITTED');
  await legacyOperation('legacy_runtime_reel_uncertain',reel,.004,'SUBMITTED');
  await legacyOperation(key,reel,.002);
  await db.query('set local role service_role');
  const before=await supplySpend(),result=await submit(db,key,10);
  assert.equal(result.submitted,false);assert.equal(result.reason,'reel budget exceeded');
  assert.equal(Number(result.committedUsd),.005);assert.equal(Number(result.pendingUsd),.004);
  assert.deepEqual(await operationState(key),{status:'RESERVED',supply_job_key:null});
  assert.equal(await supplySpend(),before);
 }));
 await check("runtime non-Audio recovery cap survives the Audio wrapper without changing prior ledger entries",async()=>legacyFixture(async()=>{
  const job='99999999-9999-4999-8999-999999999999',project=`documentary:${ownerId}:post-audio-fixture`,key='legacy_runtime_recovery_exceeded';
  await db.query("insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status) values($1,$2,'post-audio-fixture','Offline wrapper fixture','failed')",[job,ownerId]);
  await db.query("insert into public.pi_recovery_budgets(project_id,job_id,owner_id,cap_usd,baseline_keys,authorization_ref) values($1,$2,$3,.01,'{}','offline-fixture-only')",[project,job,ownerId]);
  await legacyOperation('legacy_runtime_recovery_paid',project,.009,'COMMITTED');
  await legacyOperation(key,project,.002);
  await db.query('set local role service_role');
  const before=await supplySpend(),result=await submit(db,key,10);
  assert.equal(result.submitted,false);assert.equal(result.reason,'recovery budget exceeded');
  assert.equal(Number(result.committedUsd),.009);assert.equal(Number(result.pendingUsd),0);
  assert.deepEqual(await operationState(key),{status:'RESERVED',supply_job_key:null});
  assert.equal((await operationState('legacy_runtime_recovery_paid')).status,'COMMITTED');
  assert.equal(await supplySpend(),before);
 }));
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
