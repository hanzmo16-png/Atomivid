import test from 'node:test';
import assert from 'node:assert/strict';
import {officialWorldPort,worldRecipe,type WorldRequest} from './official';
import {sha256Hex} from '../../paid-calls/result-store';
const bytes=Buffer.from('fixture-image');
const r:WorldRequest={environmentId:'beach',phase:'motion',prompt:'Slow waves',reference:{bytes,sha256:sha256Hex(bytes),mimeType:'image/png'}};
test('official payload is silent, fixed six seconds, references measured frame law',()=>{
 const p=worldRecipe(r);assert.equal(p.provider,'ltx');assert.equal(p.reservedUsd,.54);
 assert.equal(p.payload.generate_audio,false);assert.equal(p.payload.duration,6);assert.equal(p.payload.fps,25);
 assert.equal(worldRecipe({...r,phase:'final'}).reservedUsd,1.02);
 assert.throws(()=>worldRecipe({...r,reference:{...r.reference!,sha256:'a'.repeat(64)}}),/REFERENCE/);
});
test('official LTX async route never forwards credentials to the download host',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const port=officialWorldPort({ltxKey:'test',sleep:async()=>{},fetch:async(url,init)=>{
  calls.push({url:String(url),init});
  if(init?.method==='POST')return Response.json({id:'job-1'});
  if(String(url).includes('api.ltx.io'))return Response.json({status:'completed',result:{video_url:'https://media.example.test/result.mp4'}});
  return new Response(Buffer.from('fixture-video'));
 }});
 const job=await port.submit(r),a=await port.finish(job,r);
 assert.equal(a.providerJobId,'job-1');assert.equal(a.costUsd,.54);assert.equal(a.costBasis,'published_rate');
 assert.equal(calls[0].url,'https://api.ltx.io/v2/image-to-video');assert.equal(calls[2].init?.headers,undefined);
});
test('official BFL actual credits are distinguished from a quote',async()=>{
 const q:WorldRequest={environmentId:'nyc',phase:'styleframe',prompt:'Empty city'};
 const port=officialWorldPort({bflKey:'test',sleep:async()=>{},fetch:async(url,init)=>{
  if(init?.method==='POST')return Response.json({id:'image-1',cost:3});
  if(String(url).includes('api.bfl.ai'))return Response.json({status:'Ready',cost:3,result:{sample:'https://media.example.test/result.png'}});
  return new Response(Buffer.from('fixture-image'));
 }});
 const a=await port.finish(await port.submit(q),q);assert.equal(a.costUsd,.03);assert.equal(a.costBasis,'provider_usage');
});
