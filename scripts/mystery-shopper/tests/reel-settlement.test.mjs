import test from 'node:test';import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';
const target=new URL('../settle-completed-reel.mjs',import.meta.url).href;
for(const mode of ['ok','pending','missing-cost','billable','ambiguous','write-fail','readback-corrupt','existing','stop'])test(`controlled storage / settlement: ${mode}`,()=>{
 const code=`
 import{writeFileSync}from'node:fs';
 const mode=${JSON.stringify(mode)},r={key:'ms-fixture-reels',module:'reels',reservedUsd:1.5};let saved=null,writes=0;
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture';process.env.GH_READ_TOKEN='fixture';
 const response=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}});
 globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??input);const m=init?.method??input?.method??'GET';
 if(u.hostname==='api.github.com')return response(u.pathname.endsWith('/timing')?{billable:{UBUNTU:{total_ms:mode==='billable'?1000:0}}}:{private:false});
 if(u.hostname!=='fixture.invalid')throw Error('No external network permitted');
 if(u.pathname.endsWith('/video_requests'))return response({status:'completed',render_attempts:1});
 if(u.pathname.endsWith('/generation_costs'))return response({footage_provider:'pexels-video-first',music_provider:'curated-library',image_generation_count:0,image_cost_usd:mode==='missing-cost'?1:0,premium_video_cost_usd:0,avatar_cost_usd:0});
 if(u.pathname.endsWith('/pi_paid_operations'))return response(Array.from({length:4},()=>({status:mode==='pending'?'SUBMITTED':'COMMITTED',committed_usd:.01})));
 if(u.pathname.includes('/object/list/'))return response([{name:'reserve-fixture.json'},...(mode==='ambiguous'?[{name:'reserve-other.json'}]:[]),...(mode==='existing'?[{name:'settle-fixture.json'}]:[]),...(mode==='stop'?[{name:'STOP'}]:[])]);
 if(u.pathname.includes('/object/')){
 if(m==='POST'){writes++;if(mode==='write-fail')return response({error:'fixture fail'},500);saved=JSON.parse(init.body);return response({Key:'fixture'});}
 if(u.pathname.includes('reserve-'))return response(r);
 if(u.pathname.endsWith('settle-fixture.json') || mode==='existing'&&u.pathname.endsWith('settle-ms-fixture-reels.json'))return response({key:r.key,spentUsd:.04});
 return response(mode==='readback-corrupt'?{key:r.key,spentUsd:999}:saved);
 }
 throw Error('Unknown fixture endpoint');};
 process.on('exit',()=>console.log('FIXTURE_WRITES='+writes));await import(${JSON.stringify(target)});`;
 const p=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});
 assert.ifError(p.error);
 const shouldPass=['ok','existing'].includes(mode);assert.equal(p.status,shouldPass?0:1,`${p.stdout}\n${p.stderr}`);
 assert.match(p.stdout,new RegExp('FIXTURE_WRITES='+(['ok','write-fail','readback-corrupt'].includes(mode)?1:0)));
});
