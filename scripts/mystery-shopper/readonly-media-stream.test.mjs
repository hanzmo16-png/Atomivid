import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {digestDelivery} from './readonly-media-stream.mjs';
import {ORIGIN} from './final-readonly-policy.mjs';
const storage = 'https://qa.supabase.co';
test('hashes every streamed byte and sends QA cookie only to application origin', async()=>{
  const calls=[]; const bytes=Buffer.from('canonical-existing-video');
  const facts=await digestDelivery(`${ORIGIN}/dashboard/download`,storage,'session=private',async(url,init)=>{
    calls.push({url,init});
    return calls.length===1 ? new Response(null,{status:302,headers:{location:`${storage}/storage/v1/object/sign/videos/existing?token=private`}}) : new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,5));c.enqueue(bytes.subarray(5));c.close();}}));
  });
  assert.deepEqual(facts,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  assert.equal(calls[0].init.headers.cookie,'session=private');
  assert.deepEqual(calls[1].init.headers,{});
  assert.ok(calls.every(c=>c.init.method==='GET'&&c.init.redirect==='manual'));
});
test('refuses provider redirects before issuing any request to them',async()=>{
  let calls=0;
  await assert.rejects(digestDelivery(`${storage}/storage/v1/object/sign/videos/existing`,storage,'session=private',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://api.openai.com/v1/generate'}});}));
  assert.equal(calls,1);
});
