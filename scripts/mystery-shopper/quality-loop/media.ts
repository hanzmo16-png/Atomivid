/** Bounded existing-asset probe. Never creates, renders or retries a job. */
export function mediaURL(value:string,origin:string):URL {
 const u=new URL(value,origin);
 if(u.username||u.password||u.hash)throw new Error('MEDIA_URL_REJECTED');
 if(u.origin===origin && /^\/api\/audio-studio\/projects\/[a-zA-Z0-9_-]+\/audio$/.test(u.pathname))return u;
 if(u.protocol==='https:' && /^[a-z0-9-]+\.supabase\.co$/.test(u.hostname) && /^\/storage\/v1\/object\/(sign|public)\/(videos|audio)\//.test(u.pathname))return u;
 throw new Error('MEDIA_SOURCE_NOT_AUTHORIZED');
}
export async function sampleMedia(value:string,origin:string,cookies:string,fetcher:typeof fetch=fetch){
 let u=mediaURL(value,origin);const limit=262144;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
 try{
  for(let i=0;i<3;i++){
   const r=await fetcher(u,{headers:{Range:`bytes=0-${limit-1}`,...(u.origin===origin&&cookies?{cookie:cookies}:{})},redirect:'manual',signal:controller.signal});
   if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();u=mediaURL(new URL(r.headers.get('location')||'',u).href,origin);continue;}
   if(r.status!==200&&r.status!==206){await r.body?.cancel();throw new Error('MEDIA_HTTP_FAILED');}
   const mime=r.headers.get('content-type')?.split(';')[0]||'';
   if(!/^(video\/mp4|audio\/(mpeg|mp3))$/.test(mime)){await r.body?.cancel();throw new Error('MEDIA_TYPE_REJECTED');}
   const reader=r.body?.getReader();if(!reader)throw new Error('EMPTY_MEDIA');let count=0;const parts:Uint8Array[]=[];
   while(count<limit){const {value,done}=await reader.read();if(done)break;if(value){const p=value.subarray(0,limit-count);parts.push(p);count+=p.length;}}
   await reader.cancel();const bytes=Buffer.concat(parts);if(!count)throw new Error('EMPTY_MEDIA');
   return {base64:bytes.toString('base64'),mime,bytes:count,fullFileVerified:false as const};
  }
  throw new Error('MEDIA_REDIRECT_LIMIT');
 }finally{clearTimeout(timer);controller.abort();}
}
