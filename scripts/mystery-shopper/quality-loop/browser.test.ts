/** Controlled local server + real Chromium. Not a production/checkout/provider certification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { observe, existingVideoEpisodeSource, existingResultPlayerChecks, readinessBlockerDetail } from './browser';
import { allowBrowserRequest } from '../../../src/lib/mystery-shopper/quality-loop/policy';
import { sampleMedia, mediaURL } from './media';
import { safeRedirectTarget } from '../../../src/lib/auth/errors';
import { runPageMaintenance } from '../../../src/lib/mystery-shopper/quality-loop/readonly-inspection';
const sha='a'.repeat(40);
test('public readiness details include only closed diagnostic codes, never arbitrary server data',()=>{
 const data={version:'resource-sentinel-readiness/1',products:{youtube:{blockers:['BALANCE_STALE','SECRET balance=123 https://private.example','BALANCE_STALE',123,{},'WORKER_COVERAGE_UNVERIFIED']}}};
 assert.equal(readinessBlockerDetail(data,'youtube'),'BALANCE_STALE, WORKER_COVERAGE_UNVERIFIED');
 assert.equal(readinessBlockerDetail(data,'reels'),'RESOURCE_OR_CROSS_PRODUCT_COVERAGE_UNVERIFIED');
 for(const d of [null,{}, {version:'old',products:data.products}])assert.equal(readinessBlockerDetail(d,'youtube'),'RESOURCE_OR_CROSS_PRODUCT_COVERAGE_UNVERIFIED');
});
test('real Chromium: four products, controlled defect detected then corrected/revalidated, no mutating request beyond login',async()=>{
 let broken=true,otherWrites=0,logins=0,housekeeping=0,optOuts=0;const loginTargets:string[]=[];
 const realFetch=globalThis.fetch;let syntheticSamples=0;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.hostname==='fixture.supabase.co'){syntheticSamples++;return new Response(new Uint8Array([0,1,2]),{status:206,headers:{'content-type':'video/mp4'}});}
  assert.equal(url.hostname,'127.0.0.1','controlled fixture never contacts an external provider');
  return realFetch(input,init);
 };
 const server=createServer(async(req,res)=>{
  const p=new URL(req.url!,'http://localhost').pathname;
  if(req.method==='POST'){
   if(p==='/login'){
    logins++;let body='';for await(const chunk of req)body+=String(chunk);
    const target=safeRedirectTarget(new URLSearchParams(body).get('redirectedFrom'))??'/dashboard';loginTargets.push(target);
    // Model a Server Action rendering the target before the browser can intercept its redirect GET.
    await runPageMaintenance(new URL(target,'http://localhost').searchParams.get('inspection'),async()=>{housekeeping++;});
    res.writeHead(303,{'Set-Cookie':'qa=1; Path=/','Location':target});return res.end();
   }
   otherWrites++;res.writeHead(500);return res.end();
  }
  if(p==='/api/build-info'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({sha,readOnlyInspectionVersion:1}));}
  if(p==='/api/command-center/resource-sentinel'){
   if(broken){res.writeHead(404,{'content-type':'text/html'});return res.end('<h1>Not Found</h1>');}
   res.setHeader('content-type','application/json');return res.end(JSON.stringify({observedAt:new Date().toISOString(),sentinel:{accountingScope:'READ_ONLY_NOT_ATOMIC_ADMISSION',accounts:[]},admission:[]}));
  }
  if(p==='/api/admin/mystery-shopper'){res.writeHead(401);return res.end('{}');}
  if(p.startsWith('/dashboard')&&!req.headers.cookie?.includes('qa=1')){res.writeHead(307,{location:'/login'});return res.end();}
  if(p==='/dashboard'||/^\/dashboard\/videos\/[^/]+$/.test(p)){
   if(new URL(req.url!,'http://localhost').searchParams.get('inspection')==='read-only')optOuts++;else housekeeping++;
  }
  res.setHeader('content-type','text/html; charset=utf-8');
  if(p==='/login'){
   const target=new URL(req.url!,'http://localhost').searchParams.get('redirectedFrom');
   const hidden=target?'<input type="hidden" name="redirectedFrom" value="'+target.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'">':'';
   return res.end('<form method="POST" action="/login">'+hidden+'<label>Correo electrónico<input name="email"></label><label>Contraseña<input name="password" type="password"></label><button>Iniciar sesión</button></form><script>fetch("/api/render",{method:"POST"}).catch(()=>{})</script>');
  }
  if(p==='/dashboard')return res.end('<h1>Biblioteca QA</h1><div class="rounded-lg">Documental<a href="/dashboard/videos/documentary">Ver</a></div><div class="rounded-lg">Reel<a href="/dashboard/videos/reel">Ver</a></div>');
  if(p.startsWith('/dashboard/videos/'))return res.end('<h1>Resultado existente</h1><video preload="none" src="/cinematic-cover.mp4"></video><video controls preload="none" style="width:200px;height:100px" src="https://fixture.supabase.co/storage/v1/object/sign/videos/result.mp4?token=fixture"></video>');
  const reel=p==='/dashboard/new';
  res.end('<style>body{margin:20px;font-family:sans-serif}button,input,textarea{min-height:44px;max-width:90vw}h1{font-size:24px}</style><h1>'+ (reel?'Generar nuevo video':'Producto QA aislado')+'</h1>'+ (reel?'<div role="radiogroup" aria-label="Guion">Guion</div><label>Tema o instrucciones<textarea></textarea></label>'+(broken?'':'<div role="radiogroup" aria-label="Duración deseada">30 s</div>'):'<label>Idioma<select><option>Español</option></select></label>')+'<div data-testid="podcast-wizard" data-hydrated="1"><ol aria-label="Pasos"><li>Inicio</li></ol><button data-testid="modalidad-visual">Narración con imágenes</button><button data-testid="modalidad-avatar">Avatar</button><button data-testid="modalidad-dialogo">Conversación</button></div>');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const env={AQL_FIXTURE:'1',MS_TARGET_URL:`http://127.0.0.1:${port}`,MYSTERY_SHOPPER_QA_EMAIL:'local-fixture@example.test',MYSTERY_SHOPPER_QA_PASSWORD:'local-test-only',MS_CHROME:process.env.E2E_CHROME,PLAYWRIGHT_MODULE:process.env.PLAYWRIGHT_MODULE};
 try{
  const refused=await fetch(`http://127.0.0.1:${port}/dashboard?inspection=read-only`,{redirect:'manual'});assert.equal(refused.status,307,'inspection never bypasses login');
  const first=await observe(env,{id:'fixture-1',trigger:'fixture',runnerSha:sha,url:'http://local/fixture-1'});
  assert.equal(first.scope,'fixture');assert.equal(first.authenticated,true);assert.equal(first.sha,sha);
  assert.equal(first.checks.find(c=>c.id==='controls-reels-412')?.state,'FAIL');
  assert.match(first.checks.find(c=>c.id==='sentinel-read')?.detail||'',/HTTP 404; backend route absent/);
  broken=false;
  const second=await observe(env,{id:'fixture-2',trigger:'fixture',runnerSha:sha,url:'http://local/fixture-2'});
  assert.equal(second.checks.find(c=>c.id==='controls-reels-412')?.state,'PASS');
  for(const p of ['youtube','reels','audio-podcast','video-podcast'])assert.ok(second.checks.some(c=>c.product===p&&c.id.startsWith('route-')));
  assert.equal(otherWrites,0);assert.equal(logins,2);assert.equal(housekeeping,0,'no authenticated housekeeping GET reached the controlled server');assert.ok(optOuts>0,'login redirect/dashboard GETs were rewritten before the server');assert.deepEqual(loginTargets,['/dashboard?inspection=read-only','/dashboard?inspection=read-only'],'Server Action target already carries the opt-out');assert.equal(second.spendUsd,0);
  assert.equal(second.checks.find(c=>c.id==='checkout-test')?.state,'BLOCKED');
  for(const product of ['youtube','reels'])for(const width of [412,1440]){
   const matches=second.checks.filter(c=>c.product===product&&c.id===`player-visible-${product}-${width}`);
   assert.equal(matches.length,1,'same acceptance check executes exactly once on result, not creation');assert.equal(matches[0].state,'PASS');
  }
  assert.equal(syntheticSamples,4,'bounded synthetic payload only; not a valid media quality fixture');
  const periodic=await observe(env,{id:'fixture-periodic',trigger:'schedule',runnerSha:sha,url:'http://local/fixture-periodic'});
  assert.equal(periodic.authenticated,true);
  for(const product of ['youtube','reels'])for(const width of [412,1440]){
   const matches=periodic.checks.filter(c=>c.product===product&&c.id===`player-visible-${product}-${width}`);
   assert.equal(matches.length,1,'periodic delivery checks are never omitted or duplicated');
   assert.equal(matches[0].state,'PASS','DOM-only delivered-player inspection must not depend on a media transfer allowance');
  }
  for(const product of ['youtube','reels','audio-podcast','video-podcast'])for(const id of ['download-sample','playback-sample','full-file-integrity']){
   assert.equal(periodic.checks.find(c=>c.product===product&&c.id===id)?.state,'BLOCKED','DOM visibility cannot certify playback, download or file integrity');
  }
  assert.equal(syntheticSamples,4,'periodic cycle must not request even a bounded media payload');
  assert.equal(otherWrites,0);assert.equal(housekeeping,0);assert.equal(logins,3);
 }finally{globalThis.fetch=realFetch;await new Promise<void>(r=>server.close(()=>r()));}
});
test('media probe rejects providers, forwards no app cookie to storage, bounds payload even when Range ignored',async()=>{
 assert.throws(()=>mediaURL('https://api.elevenlabs.io/v1/x','https://atomivid.vercel.app'));
 let cookie:unknown;const raw=new Uint8Array(300000);let cancelled=false;
 const fake=(async(_u:unknown,init:RequestInit)=>{cookie=(init.headers as Record<string,string>).cookie;return new Response(new ReadableStream({start(c){c.enqueue(raw);},cancel(){cancelled=true;}}),{headers:{'content-type':'video/mp4'}});}) as typeof fetch;
 const r=await sampleMedia('https://project.supabase.co/storage/v1/object/sign/videos/x?token=test','https://atomivid.vercel.app','secret-cookie',fake);
 assert.equal(r.bytes,262144);assert.equal(cookie,undefined);assert.equal(cancelled,true);assert.equal(r.fullFileVerified,false);
});

// No Chromium or authentication is started for a backend that ignores inspection parameters.
test('missing read-only backend capability blocks before login or any dashboard GET',async()=>{
 let unexpected=0;const seen:string[]=[];
 const server=createServer((req,res)=>{const p=new URL(req.url!,'http://localhost').pathname;seen.push(p);res.setHeader('content-type','application/json');if(p!=='/api/build-info')unexpected++;res.end(JSON.stringify({sha}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 try {
  const out=await observe({AQL_FIXTURE:'1',MS_TARGET_URL:`http://127.0.0.1:${port}`,MYSTERY_SHOPPER_QA_EMAIL:'fixture@example.test',MYSTERY_SHOPPER_QA_PASSWORD:'fixture-only'}, {id:'unsupported-backend',trigger:'fixture',runnerSha:sha,url:'http://local/unsupported'});
  assert.equal(out.authenticated,false);assert.deepEqual(seen,['/api/build-info']);assert.equal(unexpected,0);assert.equal(out.checks.find(c=>c.id==='inspection-readonly-capability')?.state,'BLOCKED');
 } finally {await new Promise<void>(r=>server.close(()=>r()));}
});

test('real Chromium fixture opens an archived ready owner episode with a revocable exact GET pin, never a background video or mutation',async()=>{
 const active='22222222-2222-4222-8222-222222222222',ready='11111111-1111-4111-8111-111111111111',other='33333333-3333-4333-8333-333333333333';
 const signed='https://fixture.supabase.co/storage/v1/object/sign/videos/owner/episode.mp4?token=fixture-only';
 const reads:string[]=[],writes:string[]=[];let mode='ok';
 const server=createServer((req,res)=>{
  const url=new URL(req.url!,'http://localhost'),p=url.pathname;
  if(req.method!=='GET'){writes.push(p);res.writeHead(500);return res.end();}
  if(p.startsWith('/api/podcast/v3/')){
   reads.push(p);res.setHeader('content-type','application/json');
   if(p.endsWith(active))return res.end(JSON.stringify({episode:{id:active,status:'generating',output:'video'},video_url:null}));
   if(p.endsWith(ready)){
    if(mode==='forbidden'){res.writeHead(403);return res.end('{}');}
    if(mode==='missing'){res.writeHead(404);return res.end('{}');}
    return res.end(JSON.stringify({episode:{id:mode==='wrong-id'?other:ready,status:'ready',output:'video'},video_url:signed}));
   }
   res.writeHead(404);return res.end('{}');
  }
  const archived=url.searchParams.get('vista')==='archivados',principal=mode==='principal',id=archived||principal?ready:active;
  res.setHeader('content-type','text/html');
  res.end(`<h1>Controlled owner library</h1><video src="/cover.mp4"></video><li data-testid="studio-episode-${id}"><span>${archived||principal?'Listo':'Generando'}</span>${principal?'':`<button data-testid="studio-abrir-${id}" type="button">Ver episodio</button>`}</li><script>
   window.opened=[];async function readEpisode(){
    const r=await fetch('/api/podcast/v3/${id}');const d=await r.json();
    if(d.episode?.status==='ready'){
     const card=document.querySelector('li');const v=document.createElement('video');v.dataset.testid='studio-player';v.src=d.video_url;v.preload='none';card.append(v);
     const a=document.createElement('a');a.dataset.testid='studio-download-mp4';a.href=d.video_url;card.append(a);
    }
    fetch('/api/podcast/v3/${id}',{method:'POST'}).catch(()=>{});
    fetch('/api/podcast/v3/${other}').catch(()=>{});
   };const open=document.querySelector('button');if(open)open.onclick=()=>{window.opened.push('${id}');void readEpisode().catch(()=>{});};else void readEpisode().catch(()=>{});</script>`);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await pw.chromium.launch({headless:true,executablePath:process.env.E2E_CHROME});
 try{
  for(const current of ['ok','principal','forbidden','missing','wrong-id']){
   mode=current;reads.length=0;let pin:string|null=null;const pins:(string|null)[]=[];
   const context=await browser.newContext({serviceWorkers:'block'});
   await context.route('**/*',async(route:{request():{url():string;method():string;resourceType():string};abort():Promise<void>;continue():Promise<void>})=>{
    const r=route.request();return allowBrowserRequest({url:r.url(),method:r.method(),origin,authenticated:true,resourceType:r.resourceType(),existingEpisodePath:pin})?route.continue():route.abort();
   });
   const page=await context.newPage();
   const result=await existingVideoEpisodeSource(page,origin,true,async()=>false,p=>{pin=p;pins.push(p);});
   assert.equal(pin,null);assert.equal(pins.at(-1),null);assert.equal(writes.length,0);
   assert.equal(reads.some(p=>p.endsWith(other)),false);assert.equal(reads.filter(p=>p.endsWith(active)).length,current==='principal'?0:1);
   if(current==='ok'||current==='principal'){
    assert.equal(result.src,signed);assert.equal(result.reason,'OWNER_READY_VIDEO_OPENED_READ_ONLY');
    assert.equal(reads.filter(p=>p.endsWith(ready)).length,2,'metadata followed by the real card detail GET');
    assert.deepEqual(await page.evaluate(()=>Reflect.get(window,'opened')),current==='principal'?[]:[ready],'no active job card opened; main ready card needs no archive click');
    const count=reads.length;
    assert.equal(await page.evaluate(async(path:string)=>{try{await fetch(path);return true;}catch{return false;}},`/api/podcast/v3/${ready}`),false,'pin revoked after discovery');
    assert.equal(reads.length,count);
   }else assert.equal(result.src,null,'denied/missing/mismatched episode metadata never produces a media PASS; not a native RLS test');
   await context.close();
  }
 }finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
});

test('episode discovery refuses a mixed deployment and stops before navigation without leaving a GET pin',async()=>{
 let navigations=0,pin:string|null='/old';
 const page={goto:async()=>{navigations++;}};
 const noBuild=await existingVideoEpisodeSource(page,'https://atomivid.vercel.app',false,async()=>false,p=>{pin=p;});
 assert.equal(noBuild.src,null);assert.equal(noBuild.reason,'DEPLOYMENT_UNVERIFIED');assert.equal(navigations,0);assert.equal(pin,null);
 await assert.rejects(existingVideoEpisodeSource(page,'https://atomivid.vercel.app',true,async()=>true,p=>{pin=p;}),/STOPPED/);
 assert.equal(navigations,0);assert.equal(pin,null);
});

test('real Chromium result-player checks require an owner result route, visible controls and authorized source at both viewports',async()=>{
 const origin='https://atomivid.vercel.app';
 const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await pw.chromium.launch({headless:true,executablePath:process.env.E2E_CHROME});
 const context=await browser.newContext({serviceWorkers:'block'});let payloads=0;
 await context.route('**/*',async(route:{request():{resourceType():string};fulfill(input:{contentType:string;body:string}):Promise<void>;abort():Promise<void>})=>{if(route.request().resourceType()==='document')return route.fulfill({contentType:'text/html',body:'<h1>Controlled existing result</h1>'});payloads++;return route.abort();});
 const page=await context.newPage();
 try{
  const body=(attrs:string)=>`<video preload="none" src="/cinematic-cover.mp4" style="display:block;width:200px;height:100px"></video><video ${attrs} preload="none" style="display:block;width:200px;height:100px"></video>`;
  await page.goto(origin+'/dashboard/videos/owner-result');
  await page.setContent(body('controls src="https://fixture.supabase.co/storage/v1/object/sign/videos/owner.mp4?token=fixture"'));
  const out=await existingResultPlayerChecks(page,origin,'youtube',async()=>false);
  assert.deepEqual(out.map(c=>[c.id,c.state]),[['player-visible-youtube-412','PASS'],['player-visible-youtube-1440','PASS']]);
  for(const attrs of ['src="https://fixture.supabase.co/storage/v1/object/sign/videos/owner.mp4?token=fixture"','controls src="https://api.provider.example/render.mp4"','controls src="/cinematic-cover.mp4"']){
   await page.setContent(body(attrs));assert.ok((await existingResultPlayerChecks(page,origin,'reels',async()=>false)).every(c=>c.state==='BLOCKED'));
  }
  await page.setContent('<video controls preload="none" hidden src="https://fixture.supabase.co/storage/v1/object/sign/videos/owner.mp4?token=fixture"></video>');
  assert.ok((await existingResultPlayerChecks(page,origin,'reels',async()=>false)).every(c=>c.state==='BLOCKED'));
  for(const path of ['/dashboard/new','/dashboard/long-form/new','/dashboard/videos/owner-result/extra']){
   await page.goto(origin+path);await page.setContent(body('controls src="https://fixture.supabase.co/storage/v1/object/sign/videos/owner.mp4?token=fixture"'));
   assert.ok((await existingResultPlayerChecks(page,origin,'youtube',async()=>false)).every(c=>c.state==='BLOCKED'));
  }
  assert.ok((await existingResultPlayerChecks(null,origin,'reels',async()=>false)).every(c=>c.state==='BLOCKED'));
  await assert.rejects(existingResultPlayerChecks(page,origin,'reels',async()=>true),/STOPPED/);
  assert.equal(payloads,0,'preload=none and DOM inspection cause no media payload requests');
 }finally{await context.close();await browser.close();}
});
