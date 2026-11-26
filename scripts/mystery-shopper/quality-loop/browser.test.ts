/** Controlled local server + real Chromium. Not a production/checkout/provider certification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { observe } from './browser';
import { sampleMedia, mediaURL } from './media';
const sha='a'.repeat(40);
test('real Chromium: four products, controlled defect detected then corrected/revalidated, no mutating request beyond login',async()=>{
 let broken=true,otherWrites=0,logins=0;
 const server=createServer((req,res)=>{
  const p=new URL(req.url!,'http://localhost').pathname;
  if(req.method==='POST'){
   if(p==='/login'){logins++;res.writeHead(303,{'Set-Cookie':'qa=1; Path=/','Location':'/dashboard'});return res.end();}
   otherWrites++;res.writeHead(500);return res.end();
  }
  if(p==='/api/build-info'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({sha}));}
  if(p==='/api/command-center/resource-sentinel'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({observedAt:new Date().toISOString(),sentinel:{accountingScope:'READ_ONLY_NOT_ATOMIC_ADMISSION',accounts:[]},admission:[]}));}
  if(p==='/api/admin/mystery-shopper'){res.writeHead(401);return res.end('{}');}
  if(p.startsWith('/dashboard')&&!req.headers.cookie?.includes('qa=1')){res.writeHead(307,{location:'/login'});return res.end();}
  res.setHeader('content-type','text/html; charset=utf-8');
  if(p==='/login')return res.end('<form method="POST" action="/login"><label>Correo electrónico<input name="email"></label><label>Contraseña<input name="password" type="password"></label><button>Iniciar sesión</button></form><script>fetch("/api/render",{method:"POST"}).catch(()=>{})</script>');
  const reel=p==='/dashboard/new';
  res.end('<style>body{margin:20px;font-family:sans-serif}button,input,textarea{min-height:44px;max-width:90vw}h1{font-size:24px}</style><h1>'+ (reel?'Generar nuevo video':'Producto QA aislado')+'</h1>'+ (reel?'<div role="radiogroup" aria-label="Guion">Guion</div><label>Tema o instrucciones<textarea></textarea></label>'+(broken?'':'<div role="radiogroup" aria-label="Duración deseada">30 s</div>'):'<label>Idioma<select><option>Español</option></select></label>')+'<div data-testid="podcast-wizard" data-hydrated="1"><ol aria-label="Pasos"><li>Inicio</li></ol><button data-testid="modalidad-visual">Narración con imágenes</button><button data-testid="modalidad-avatar">Avatar</button><button data-testid="modalidad-dialogo">Conversación</button></div>');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const env={AQL_FIXTURE:'1',MS_TARGET_URL:`http://127.0.0.1:${port}`,MYSTERY_SHOPPER_QA_EMAIL:'local-fixture@example.test',MYSTERY_SHOPPER_QA_PASSWORD:'local-test-only',MS_CHROME:process.env.E2E_CHROME};
 try{
  const first=await observe(env,{id:'fixture-1',trigger:'fixture',runnerSha:sha,url:'http://local/fixture-1'});
  assert.equal(first.scope,'fixture');assert.equal(first.authenticated,true);assert.equal(first.sha,sha);
  assert.equal(first.checks.find(c=>c.id==='controls-reels-412')?.state,'FAIL');
  broken=false;
  const second=await observe(env,{id:'fixture-2',trigger:'fixture',runnerSha:sha,url:'http://local/fixture-2'});
  assert.equal(second.checks.find(c=>c.id==='controls-reels-412')?.state,'PASS');
  for(const p of ['youtube','reels','audio-podcast','video-podcast'])assert.ok(second.checks.some(c=>c.product===p&&c.id.startsWith('route-')));
  assert.equal(otherWrites,0);assert.equal(logins,2);assert.equal(second.spendUsd,0);
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
