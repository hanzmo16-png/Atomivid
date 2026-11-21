import { ownedChannel } from "@/lib/distribution/youtube/studio/model";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { supabaseYouTubeOAuthStore } from "@/lib/distribution/youtube/oauth-store";
import { studioAccessToken, studioOAuthConfigured } from "@/lib/distribution/youtube/studio/access";
import { SCOPES } from "@/lib/distribution/youtube/capabilities";
import { readStudio, StudioReadError } from "@/lib/distribution/youtube/studio/read";
export const dynamic="force-dynamic";
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store","Vary":"Cookie"}});
export async function GET(request:Request){
 try{
 const auth=await createClient();const {data:{user}}=await auth.auth.getUser();if(!user)return reply({error:"unauthenticated"},401);
 const sb=createServiceClient();
 // Service role requires explicit owner filter before any connection or token access.
 const {data:channels,error}=await sb.from("yt_channels").select("channel_id,owner_user_id,title,status,connection_id").eq("owner_user_id",user.id);
 if(error)return reply({error:"channel_store_unavailable"},503);
 const {data:ready,error:readyError}=await auth.from("video_requests").select("id,topic,mode").eq("user_id",user.id).eq("status","completed").not("video_path","is",null).order("created_at",{ascending:false}).limit(100);
 if(readyError)return reply({error:"library_unavailable"},503);
 const q=new URL(request.url).searchParams, id=q.get("channel");
 const safe=(channels??[]).map(c=>({id:c.channel_id,title:c.title,status:c.status}));
 if(!id)return reply({owner:user.id,channels:safe,ready:(ready??[]).map(v=>({id:v.id,title:v.topic??"Video",mode:v.mode})),source:"stored",googleReadConfigured:studioOAuthConfigured(process.env),writeEnabled:false});
 const selected=ownedChannel(user.id,channels??[],id);if(!selected)return reply({error:"channel_not_found"},404);
 if(!studioOAuthConfigured(process.env))return reply({error:"configuration"},503);
 const store=supabaseYouTubeOAuthStore(sb);const connection=await store.getConnection(selected.connection_id);
 if(!connection)return reply({error:"reconnect"},409);
 const allowed=[...SCOPES.READ_CHANNEL,...SCOPES.READ_ANALYTICS];
 if(!SCOPES.READ_CHANNEL.every(s=>connection.scopes.includes(s))||connection.scopes.some(s=>!allowed.includes(s)))return reply({error:"permission"},403);
 const token=await studioAccessToken({store,env:process.env,fetch},selected.connection_id);
 const live=await readStudio(token,id,q.get("page")??undefined,q.get("analytics")==="true"&&SCOPES.READ_ANALYTICS.every(s=>connection.scopes.includes(s)));
 return reply(live);
 }catch(e){return reply({error:e instanceof StudioReadError?e.code:"unavailable"},e instanceof StudioReadError?e.http:503);}
}
// No POST/PUT/PATCH/DELETE, upload, revoke, scheduling, paid provider or background retry.
