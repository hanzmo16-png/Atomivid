import { imageUrl } from "./model";
export class StudioReadError extends Error { constructor(public code: "reconnect"|"quota"|"permission"|"unavailable"|"invalid", public http: number) { super(code); } }
type Json = Record<string, unknown>;
type Item = { id?: string; snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: {default?: {url?: string}; medium?: {url?:string}}; resourceId?: {videoId?:string} }; statistics?: Record<string,string>; contentDetails?: { duration?: string; relatedPlaylists?:{uploads?:string} }; status?:{privacyStatus?:string} };
export type StudioRead = { source:"google-live"; fetchedAt:string; channel:{id:string; title:string; thumbnail?:string; statistics:Record<string,string>}; videos:{id:string; title:string; thumbnail?:string; duration:string; publishedAt:string; privacy:string; statistics:Record<string,string>}[]; nextPage?:string; analytics:{available:boolean; rows:unknown[][]; columns:string[]; reason?:string} };
export async function readStudio(token:string, channelId:string, page:string|undefined, analytics:boolean, run:typeof fetch=fetch):Promise<StudioRead> {
 if (!/^UC[\w-]{22}$/.test(channelId) || (page && !/^[\w=-]{1,256}$/.test(page))) throw new StudioReadError("invalid",400);
 const get=async(url:URL):Promise<Json>=>{
  try { const r=await run(url,{method:"GET",headers:{Authorization:`Bearer ${token}`},cache:"no-store",signal:AbortSignal.timeout(12_000)});
   if(!r.ok){let reason="";try{const e=await r.json();reason=e?.error?.errors?.[0]?.reason??"";}catch{}
    const quota=r.status===429||["quotaExceeded","dailyLimitExceeded"].includes(reason);
    throw new StudioReadError(r.status===401?"reconnect":quota?"quota":r.status===403?"permission":"unavailable",r.status===401?401:quota?429:r.status===403?403:502);}
   return await r.json() as Json;
  }catch(e){if(e instanceof StudioReadError)throw e;throw new StudioReadError("unavailable",502);}
 };
 const url=(resource:string,q:Record<string,string>)=>new URL(`https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(q)}`);
 const ch=await get(url("channels",{part:"snippet,statistics,contentDetails",id:channelId}));
 const c=(ch.items as Item[])?.find(c=>c.id===channelId);if(!c)throw new StudioReadError("permission",403);
 const playlist=c.contentDetails?.relatedPlaylists?.uploads;
 let videos:Item[]=[];let nextPage:string|undefined;
 if(playlist){const list=await get(url("playlistItems",{part:"snippet",playlistId:playlist,maxResults:"25",...(page?{pageToken:page}:{})}));
  const ids=((list.items??[]) as Item[]).map(i=>i.snippet?.resourceId?.videoId).filter((id):id is string=>!!id&&/^[\w-]{11}$/.test(id));nextPage=typeof list.nextPageToken==="string"?list.nextPageToken:undefined;
  if(ids.length){const v=await get(url("videos",{part:"snippet,contentDetails,status,statistics",id:ids.join(",")}));videos=(v.items??[]) as Item[];}
 }
 let a:StudioRead["analytics"]={available:false,rows:[],columns:[],reason:"No consultadas. Requiere permiso Analytics y una consulta explícita."};
 if(analytics){const end=new Date();end.setUTCDate(end.getUTCDate()-2);const start=new Date(end);start.setUTCDate(start.getUTCDate()-27);
  try{const data=await get(new URL(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ids:`channel==${channelId}`,startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),metrics:"views,estimatedMinutesWatched,subscribersGained,subscribersLost",dimensions:"day",sort:"day"})}`));a={available:true,rows:(data.rows??[]) as unknown[][],columns:((data.columnHeaders??[]) as {name:string}[]).map(c=>c.name)};}catch(e){a={available:false,rows:[],columns:[],reason:e instanceof StudioReadError?e.code:"unavailable"};}
 }
 return {source:"google-live",fetchedAt:new Date().toISOString(),channel:{id:channelId,title:c.snippet?.title??"",thumbnail:imageUrl(c.snippet?.thumbnails?.default?.url),statistics:c.statistics??{}},videos:videos.map(v=>({id:v.id??"",title:v.snippet?.title??"",thumbnail:imageUrl(v.snippet?.thumbnails?.medium?.url),duration:v.contentDetails?.duration??"",publishedAt:v.snippet?.publishedAt??"",privacy:v.status?.privacyStatus??"desconocida",statistics:v.statistics??{}})),nextPage,analytics:a};
}
