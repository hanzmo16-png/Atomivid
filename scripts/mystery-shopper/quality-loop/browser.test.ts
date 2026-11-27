/** Controlled local server + real Chromium. Not a production/checkout/provider certification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { observe } from './browser';
import { sampleMedia, mediaURL } from './media';
import { safeRedirectTarget } from '../../../src/lib/auth/errors';
import { runPageMaintenance } from '../../../src/lib/mystery-shopper/quality-loop/readonly-inspection';
const sha='a'.repeat(40);
test('real Chromium: four products, controlled defect detected then corrected/revalidated, no mutating request beyond login',async()=>{
 let broken=true,otherWrites=0,logins=0,housekeeping=0,optOuts=0;const loginTargets:string[]=[];
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
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
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
