/** Browser regression of the real editor with local mocked API responses; no providers or credentials. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '../../../..');
const entry = 'import React from \'react\';\nimport { createRoot } from \'react-dom/client\';\nimport { AudioEditor } from \'./src/app/dashboard/audio-studio/AudioEditor\';\nimport { newProject, applyInput, VOICE_PRESETS, TTS_MODELS, modelRate, estimate, musicPlan, readinessIssues } from \'./src/lib/audio-studio/model\';\nconst view = (p) => { const rate=modelRate(p.ttsModel, {}); const e=estimate(p,rate.rate); return {...p,estimate:e,musicPlan:musicPlan(p.script,p.music),readiness:readinessIssues(p,e),rate,rates:TTS_MODELS.map(m=>modelRate(m.id,{}))}; };\nconst now = new Date().toISOString();\nconst p = view(applyInput(newProject({id:\'aaaaaaaa-aaaa-4aaa-8aaa-000000000002\',ownerId:\'11111111-1111-4111-8111-111111111111\',now,title:\'Islas Flannan\'}), {script: \'El farero miró el mar y buscó la luz. \'.repeat(90),targetMinutes:5,budgetUsd:10},now),{});\nwindow.fixture = p;\nwindow.catalog = VOICE_PRESETS.map(v=>({...v,models:TTS_MODELS.map(m=>m.id)}));\ncreateRoot(document.getElementById(\'root\')!).render(<AudioEditor initial={p} synthesis="real" />);\n';
const bundle = buildSync({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,platform:"browser",jsx:"automatic",tsconfig:path.join(root,"tsconfig.json"),write:false}).outputFiles[0].contents;
(async()=>{
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:'<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script></html>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try{
browser=await chromium.launch({headless:true,executablePath:process.env.E2E_CHROME || undefined});
for(const width of [390,1440]) {
 const page=await browser.newPage({viewport:{width,height:844}});
 let project,posts=0,release,failGet=false;
 await page.route('**/api/audio-studio/**',async route=>{
  const req=route.request();
  if(req.url().endsWith('/voices')) {const voices=await page.evaluate(()=>window.catalog);return route.fulfill({json:{voices,synthesis:'real'}});}
  if(req.method()==='POST') {posts++;await new Promise(r=>release=r);project.generation={...project.generation,status:'en_cola',heartbeatAt:new Date().toISOString()};return route.fulfill({status:202,json:project});}
  if(failGet) return route.abort();
  return route.fulfill({json:project});
 });
 await page.goto(base);
 project=await page.evaluate(()=>window.fixture);
 await page.getByTestId('audio-authorize').check();
 await page.getByTestId('audio-generate').click();
 await page.getByTestId('audio-progress').getByText('Enviando solicitud de generación…',{exact:true}).waitFor();
 assert(await page.getByTestId('audio-generate').isDisabled());assert.equal(posts,1);
 release();
 await page.getByTestId('audio-progress').getByText('Solicitud recibida · esperando para comenzar',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('audio-generate').count(),0);
 project.generation={...project.generation,status:'generando',progress:{done:7,total:20},heartbeatAt:new Date().toISOString()};
 await page.getByText('Generando voces · 35%',{exact:true}).waitFor();
 failGet=true;await page.getByText('Comprobando el estado del podcast…',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('audio-generate').count(),0);
 failGet=false;project.generation.progress={done:20,total:20};
 await page.getByText('Voces completas · mezclando y preparando el MP3…',{exact:true}).waitFor();
 assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),null);
 project.generation.status='terminada';
 await page.getByText('Podcast listo · 100%',{exact:true}).waitFor();assert.equal(posts,1);
 console.log('PASS',width,'click, queue, 35%, connection loss/recovery, mixing, completed, one POST');
 // A failed POST response must not offer another paid generation while reconciliation is pending.
 await page.unroute('**/api/audio-studio/**');
 await page.route('**/api/audio-studio/**', async route => {
   if(route.request().url().endsWith('/voices')) return route.fulfill({json:{voices:await page.evaluate(()=>window.catalog),synthesis:'real'}});
   if(route.request().method()==='POST') {posts++; return route.abort();}
   return route.fulfill({json:project});
 });
 await page.reload();project=await page.evaluate(()=>window.fixture);
 await page.getByTestId('audio-authorize').check();await page.getByTestId('audio-generate').click();
 await page.getByText('Comprobando el estado del podcast…',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('audio-generate').count(),0);
 // An unchanged idle snapshot is ambiguous; never automatically retry the mutation.
 await page.waitForTimeout(3500);
 assert.equal(await page.getByTestId('audio-generate').count(),0);assert.equal(posts,2);
 project.generation={...project.generation,status:'en_cola',heartbeatAt:new Date().toISOString()};
 await page.getByText('Solicitud recibida · esperando para comenzar',{exact:true}).waitFor();
 console.log('PASS',width,'lost POST response reconciles through GET without a duplicate POST');
 await page.close();
}
}finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
