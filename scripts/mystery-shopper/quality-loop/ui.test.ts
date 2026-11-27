/** Actual React panel, isolated API and real Chromium. No app auth bypass is shipped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { initialQueue, publicView, claimCycle, finishCycle, claimDefect, event, type Cycle } from '../../../src/lib/mystery-shopper/quality-loop/model';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load=()=>import(process.env.PLAYWRIGHT_MODULE||'playwright') as Promise<any>;
test('admin panel renders mobile/desktop, persisted claim and stop/start via isolated API',async()=>{
 const root=process.cwd(),dir=await mkdtemp(path.join(tmpdir(),'quality-ui-'));
 const evidenceDir=process.env.AQL_EVIDENCE_DIR||dir;await mkdir(evidenceDir,{recursive:true});
 const link=path.join(dir,'link.tsx');await writeFile(link,"import React from 'react';export default function Link(p:any){return <a {...p}/>}");
 const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{QualityLoopPanel}from'${root}/src/app/dashboard/command-center/quality-loop/QualityLoopPanel';createRoot(document.getElementById('root')!).render(<QualityLoopPanel/>);`;
 const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',alias:{'next/link':link},nodePaths:[path.join(root,'node_modules')],define:{'process.env.NODE_ENV':'"production"'}});
 const css=(await postcss([tailwind({base:root,optimize:true})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')})).css;
 const at=new Date().toISOString(),q=initialQueue(at),sha='a'.repeat(40);
 const cycle:Cycle={id:'fixture-ui',trigger:'fixture',scope:'authenticated-readonly',startedAt:at,finishedAt:at,sha,runnerSha:sha,url:'https://github.com/example/repo/actions/runs/1',authenticated:true,sentinel:'BLOCKED',spendUsd:0,checks:[{id:'fixture-layout',product:'reels',state:'FAIL',severity:'P1',owner:'claude',module:'ui',detail:'Controlled layout fixture'}]};
 finishCycle(q,cycle,claimCycle(q,cycle.id,at));
 const server=createServer(async(req,res)=>{
  const p=new URL(req.url!,'http://localhost').pathname;
  if(p==='/app.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
  if(p==='/style.css'){res.setHeader('content-type','text/css');return res.end(css);}
  if(p==='/api/command-center/quality-loop'){
   res.setHeader('content-type','application/json');
   if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const v=JSON.parse(body);if(v.action==='claim'){const token=claimDefect(q,v.id,v.owner,'controlled-claude-fixture',new Date().toISOString());return res.end(JSON.stringify({ok:true,token}));}q.enabled=v.action==='start';event(q,new Date().toISOString(),'Admin fixture toggle');return res.end('{"ok":true}');}
   return res.end(JSON.stringify({...publicView(q,new Date().toISOString()),claimTokens:Object.fromEntries(q.defects.filter(d=>d.claim?.actor==='controlled-claude-fixture').map(d=>[d.id,d.claim!.token]))}));
  }
  res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const pw=await load(),browser=await pw.chromium.launch({headless:true,executablePath:process.env.E2E_CHROME});
 try{
  const page=await browser.newPage();
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:900});await page.goto(`http://127.0.0.1:${port}`);
   await page.getByRole('button',{name:'Parada de emergencia'}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.screenshot({path:path.join(evidenceDir,`quality-loop-${width}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'Reclamar como claude'}).click();await page.getByLabel('SHA corregido').waitFor();assert.equal(q.defects[0].state,'CLAIMED');
  await page.reload();await page.getByRole('button',{name:'Parada de emergencia'}).waitFor();
  if(process.env.AQL_RELOAD_EVIDENCE)await page.screenshot({path:process.env.AQL_RELOAD_EVIDENCE,fullPage:true});
  await page.getByLabel('SHA corregido').waitFor({timeout:1500});
  await page.getByRole('button',{name:'Parada de emergencia'}).click();await page.getByRole('button',{name:'Activar ciclo'}).waitFor();assert.equal(q.enabled,false);
  await page.getByRole('button',{name:'Activar ciclo'}).click();await page.getByRole('button',{name:'Parada de emergencia'}).waitFor();assert.equal(q.enabled,true);
 }finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
});
