// Actual shared client component + production CSS, fixture HTTP only. No OAuth/API certification.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),require=createRequire(root+'/package.json');
const qaRequire=createRequire((process.env.YOUTUBE_QA_DEPS||root)+'/package.json');
const {chromium}=qaRequire('playwright'),axe=qaRequire.resolve('axe-core/axe.min.js');
const out=process.env.YOUTUBE_QA_OUT||root+'/.youtube-qa';mkdirSync(out,{recursive:true});
const temp=mkdtempSync(path.join(tmpdir(),'youtube-qa-'));
writeFileSync(temp+'/entry.tsx',`import React from '${root}/node_modules/react';import {createRoot} from '${root}/node_modules/react-dom/client';import {YouTubeStudio} from '${root}/src/app/dashboard/youtube/YouTubeStudio';createRoot(document.getElementById('root')!).render(<YouTubeStudio/>);`);
await require('esbuild').build({entryPoints:[temp+'/entry.tsx'],bundle:true,outfile:temp+'/app.js',platform:'browser',jsx:'automatic',jsxImportSource:root+'/node_modules/react',nodePaths:[root+'/node_modules'],tsconfig:root+'/tsconfig.json',define:{'process.env.NODE_ENV':'"production"','process.env':'{}'}});
const css=await require('postcss')([require('@tailwindcss/postcss')({base:root})]).process(readFileSync(root+'/src/app/globals.css','utf8'),{from:root+'/src/app/globals.css'});
writeFileSync(temp+'/app.css',css.css);
const html='<!doctype html><html lang="es"><head><title>YouTube Studio · FIXTURE QA</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><aside style="background:#172554;color:white;padding:12px">PRUEBA LOCAL · DATOS SINTÉTICOS · SIN CONEXIÓN A GOOGLE</aside><div id="root"></div><script src="/app.js"></script></body></html>';
const server=createServer((req,res)=>{const f={'/app.js':'app.js','/app.css':'app.css'}[req.url];res.setHeader('Content-Type',f?.endsWith('js')?'text/javascript':f?'text/css':'text/html');res.end(f?readFileSync(temp+'/'+f):html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
const report={source:'SYNTHETIC HTTP FIXTURES · actual component and production CSS · NOT Google/OAuth/Next authenticated E2E',cases:[],blockedExternal:[],errors:[]};
try{
 for(const viewport of [{width:390,height:844},{width:412,height:915},{width:1440,height:900}]){
  const context=await browser.newContext({viewport});const page=await context.newPage();let quota=false;
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.origin!==origin){report.blockedExternal.push(u.origin+u.pathname);return route.abort();}
   if(u.pathname==='/api/distribution/youtube/studio'){
    if(!u.search){return route.fulfill({json:{owner:'fixture-owner',channels:[{id:'UC'+'a'.repeat(22),title:'Canal FIXTURE',status:'connected'}],ready:[{id:'done',title:'Video terminado FIXTURE',mode:'long_form'}]}});}
    if(quota)return route.fulfill({status:429,json:{error:'quota'}});
    return route.fulfill({json:{source:'google-live',fetchedAt:'2026-11-21T00:00:00Z',channel:{id:'UC'+'a'.repeat(22),title:'Canal FIXTURE',statistics:{viewCount:'35',subscriberCount:'8'}},videos:[{id:'abcdefghijk',title:'Largo FIXTURE',duration:'PT5M',privacy:'private',publishedAt:'2026-11-01T00:00:00Z',statistics:{viewCount:'25'}},{id:'abcdefghijx',title:'Corto FIXTURE',duration:'PT30S',privacy:'public',publishedAt:'2026-11-02T00:00:00Z',statistics:{viewCount:'10'}}],analytics:{available:u.searchParams.has('analytics'),columns:['day','views'],rows:[['2026-11-01',35]]}}});
   }
   if(u.pathname.startsWith('/api/'))throw new Error('Unexpected API attempt: '+u.pathname);
   return route.continue();
  });
  await page.goto(origin);await page.getByLabel('Video terminado',{exact:true}).selectOption('done');
  await page.getByLabel('Descripción',{exact:true}).fill('Descripción idéntica al borrador guardado');
  await page.getByLabel('Etiquetas separadas por comas').fill('viajes,oro histórico');
  await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.getByText('Borrador guardado en este teléfono.',{exact:false}).waitFor();
  await page.reload();await page.getByLabel('Descripción',{exact:true}).waitFor();assert.equal(await page.getByLabel('Descripción',{exact:true}).inputValue(),'Descripción idéntica al borrador guardado');
  await page.getByRole('button',{name:'Previsualizar',exact:true}).click();await page.getByRole('heading',{name:'Vista previa · borrador'}).waitFor();
  await page.getByRole('button',{name:'Consultar canal y videos',exact:true}).click();await page.getByRole('heading',{name:'Largo FIXTURE',exact:true}).waitFor();
  await page.getByLabel('Formato',{exact:true}).selectOption('short');await page.getByRole('heading',{name:'Corto FIXTURE',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Largo FIXTURE',exact:true}).count(),0);
  await page.getByRole('button',{name:'Consultar estadísticas de 28 días'}).click();await page.getByRole('table').waitFor();
  assert.equal(await page.getByRole('button',{name:'Publicar en YouTube — deshabilitado'}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Desconectar (requiere autorización)'}).isDisabled(),true);
  await page.addScriptTag({path:axe});const accessibility=await page.evaluate(async()=>await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));const serious=accessibility.violations.filter(v=>['serious','critical'].includes(v.impact));assert.equal(serious.length,0,JSON.stringify(serious));
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  await page.screenshot({path:out+`/studio-${viewport.width}.png`,fullPage:true});
  quota=true;await page.getByRole('button',{name:'Consultar canal y videos',exact:true}).click();await page.getByRole('alert').filter({hasText:'cuota'}).waitFor();
  report.cases.push({viewport,draftReload:true,preview:true,libraryFilter:true,analyticsFixture:true,writeActionsDisabled:true,quotaError:true,horizontalOverflow:false,seriousOrCritical:serious.length,allAxeViolations:accessibility.violations.map(v=>({id:v.id,impact:v.impact}))});await context.close();
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.blockedExternal,[]);
}finally{writeFileSync(out+'/mobile-desktop.json',JSON.stringify(report,null,2));await browser.close();server.close();}
console.log(JSON.stringify(report,null,2));
