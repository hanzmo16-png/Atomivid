// Cache ONLY successful public stock-search JSON in the already authorized PRIVATE bucket.
// No credentials, request headers, private media, paid-provider calls, or eligibility decisions are cached.
import {createHash} from 'node:crypto';
export async function installPrivateStockSearchCache(storage,{runId,deadlineMs=240000,now=Date.now,fetchImpl=globalThis.fetch}={}){
 const privacy=await storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('private stock cache requires a private bucket');
 const bucket=storage.from('videos'),original=fetchImpl,deadline=now()+deadlineMs;let blockedUntil=0,sequence=0;
 const event=async(data)=>{const n=++sequence,receipt={scope:'PRIVATE_FREE_STOCK_SEARCH',at:new Date(now()).toISOString(),sequence:n,...data};const r=await bucket.upload(`mystery-shopper/v3/receipts/stock-search-${runId}-${String(n).padStart(4,'0')}.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(r.error)throw Error('private stock evidence unavailable');};
 const wrapped=async(input,init)=>{
  const raw=typeof input==='string'?input:input instanceof URL?input.href:input.url;const url=new URL(raw);
  if(url.origin!=='https://api.pexels.com'||!['/videos/search','/v1/search'].includes(url.pathname)||(init?.method??'GET').toUpperCase()!=='GET')return original(input,init);
  const keys=[...url.searchParams.keys()];if(keys.some(k=>!['query','orientation','per_page','size','locale','page'].includes(k)))throw Error('unexpected stock search parameters');
  url.searchParams.sort();const canonical=url.href,key=createHash('sha256').update(canonical).digest('hex'),hour=new Date(now()).toISOString().slice(0,13),path=`mystery-shopper/v3/stock-search-cache/${hour}/${key}.json`;
  const found=await bucket.download(path);
  if(!found.error&&found.data){const entry=JSON.parse(await found.data.text());if(entry.url!==canonical||typeof entry.body!=='string'||createHash('sha256').update(entry.body).digest('hex')!==entry.sha256)throw Error('stock cache integrity mismatch');if(entry.expiresAt>now()&&entry.createdAt<=now()){await event({key,cached:true,status:200});return new Response(entry.body,{status:200,headers:{'content-type':'application/json'}});}}
  // A 429 never causes another network request before the provider's window; no hour-long orphan timer.
  if(now()>=deadline||now()<blockedUntil)throw Error('stock free-search deadline or provider window blocks a new request');
  const left=Math.min(20000,deadline-now()),signal=init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(left)]):AbortSignal.timeout(left);let response;
  try{response=await original(canonical,{...init,signal});}catch(error){await event({key,cached:false,status:'network_error'});throw error;}
  if(response.status===429){const reset=Number(response.headers.get('x-ratelimit-reset')),retry=Number(response.headers.get('retry-after'));blockedUntil=Number.isFinite(reset)&&reset>0?reset*1000+2000:now()+(retry>0?retry*1000:60000);await event({key,cached:false,status:429,blockedUntil});await response.body?.cancel();throw Error('stock provider quota window: no retry before reset');}
  if(!response.ok){await event({key,cached:false,status:response.status});return response;}
  const body=await response.text();if(Buffer.byteLength(body)>2000000)throw Error('stock search response too large');JSON.parse(body);
  const entry={url:canonical,body,sha256:createHash('sha256').update(body).digest('hex'),createdAt:now(),expiresAt:now()+3600000};
  const saved=await bucket.upload(path,JSON.stringify(entry),{contentType:'application/json',upsert:false});if(saved.error&&saved.error.statusCode!=='409'&&saved.error.status!==409)throw Error('stock cache write failed');
  await event({key,cached:false,status:200});return new Response(body,{status:200,headers:{'content-type':'application/json'}});
 };
 globalThis.fetch=wrapped;return()=>{if(globalThis.fetch===wrapped)globalThis.fetch=original;};
}
