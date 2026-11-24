// Follow the application redirect explicitly: never hide the failing hop, or follow a signed URL off loopback.
const fs = require('node:fs');
const local = (url) => url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
async function downloadMp3(request, endpoint, file) {
 const origin = new URL(endpoint);
 if (!local(origin)) throw new Error('E2E audio endpoint must be loopback');
 const first = await request.get(origin.href, { maxRedirects: 0 });
 let response=first;
 if (first.status()===302) {
  const location=first.headers().location;
  if (!location) throw new Error('Missing signed download Location');
  const target=new URL(location,origin);
  if (!local(target)) throw new Error('Refusing signed download outside loopback');
  response=await request.get(target.href,{maxRedirects:0});
 }
 const body=await response.body();
 if(file)fs.writeFileSync(file,body);
 const url=new URL(response.url());
 return {initialStatus:first.status(),status:response.status(),type:response.headers()['content-type']||'',bytes:body.length,
  mp3:first.status()===302 && response.status()===200 && body.length>1000 && ((body[0]===0x49&&body[1]===0x44&&body[2]===0x33)||(body[0]===0xff&&(body[1]&0xe0)===0xe0)),
  finalPath:url.origin+url.pathname}; // Deliberately omit query tokens.
}
module.exports={downloadMp3};
