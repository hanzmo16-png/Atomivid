const {test}=require('node:test');const assert=require('node:assert/strict');const {downloadMp3}=require('./download.cjs');
const mp3=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(2000)]);
const response=(status,type,body,url,location)=>({status:()=>status,headers:()=>({'content-type':type,location}),body:async()=>body,url:()=>url});
const endpoint='http://127.0.0.1:3300/api/audio-studio/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/audio?descargar=1';
test('real redirect contract, bytes retained, token absent from diagnostics',async()=>{
 const urls=[];const request={get:async(url,options)=>{urls.push([url,options]);return urls.length===1?response(302,'',Buffer.alloc(0),endpoint,'http://127.0.0.1:54821/storage/file.mp3?token=fixture'):response(200,'audio/mpeg',mp3,url)}};
 const r=await downloadMp3(request,endpoint);assert.equal(r.mp3,true);assert.equal(r.bytes,mp3.length);assert.equal(r.initialStatus,302);assert.ok(!JSON.stringify(r).includes('fixture'));assert.ok(urls.every(x=>x[1].maxRedirects===0));
});
test('HTML404 remains failure at its original hop; no retry or fallback',async()=>{
 let calls=0;const r=await downloadMp3({get:async()=>{calls++;return response(404,'text/html',Buffer.from('<h1>not found</h1>'),endpoint)}},endpoint);assert.equal(r.mp3,false);assert.equal(r.initialStatus,404);assert.equal(calls,1);
});
test('external signed Location is never fetched',async()=>{
 let calls=0;await assert.rejects(downloadMp3({get:async()=>{calls++;return response(302,'',Buffer.alloc(0),endpoint,'https://production.invalid/signed?token=secret')}},endpoint),/outside loopback/);assert.equal(calls,1);
});
test('a second redirect cannot silently escape loopback',async()=>{
 let calls=0;const r=await downloadMp3({get:async(url)=>{calls++;return response(302,'',Buffer.alloc(0),url,calls===1?'http://127.0.0.1:54821/file':'https://production.invalid/file')}},endpoint);assert.equal(calls,2);assert.equal(r.mp3,false);
});
test('HTML200 or MP3-looking error bytes are never valid downloads',async()=>{
 for (const status of [200,403,404]){const r=await downloadMp3({get:async()=>response(status,'text/html',mp3,endpoint)},endpoint);assert.equal(r.mp3,false);}
});
