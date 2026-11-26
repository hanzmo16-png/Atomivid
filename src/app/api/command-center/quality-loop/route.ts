import { createHash } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { requireCommandCenterAdmin, CommandCenterAccessError } from '@/lib/command-center/access';
import { GitHubQueueStore, update } from '@/lib/mystery-shopper/quality-loop/github-store';
import { publicView, claimDefect, transition, event } from '@/lib/mystery-shopper/quality-loop/model';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Robots-Tag':'noindex'};
async function gate(){
 const auth=await createClient();const {data:{user},error}=await auth.auth.getUser();requireCommandCenterAdmin(error?null:user);
 return createHash('sha256').update(user!.id).digest('hex').slice(0,16);
}
const store=()=>new GitHubQueueStore('hanzmo16-png/Atomivid',process.env.GH_WORKER_TOKEN);
function failure(e:unknown){return Response.json({error:e instanceof CommandCenterAccessError?'Access denied':e instanceof Error&&/CLAIM|TRANSITION|STOPPED/.test(e.message)?e.message:'Quality loop unavailable'}, {status:e instanceof CommandCenterAccessError?e.status:503,headers});}
export async function GET(){try{await gate();return Response.json(publicView((await store().read()).state,new Date().toISOString()),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  const actor=await gate();
  // Same-origin POST plus admin auth; no untrusted Origin can stop/claim work.
  const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return Response.json({error:'Origin rejected'},{status:403,headers});
  const b=await request.json() as {action?:string;id?:string;owner?:'codex'|'claude';token?:string;sha?:string};
  const at=new Date().toISOString();
  if(b.action==='stop'||b.action==='start'){
   await update(store(),q=>{q.enabled=b.action==='start';if(!q.enabled)q.lease=null;event(q,at,q.enabled?'Admin activated loop':'Emergency stop by admin');});
   return Response.json({ok:true},{headers});
  }
  if(b.action==='claim'&&b.id&&['codex','claude'].includes(b.owner||'')){
   const token=await update(store(),q=>claimDefect(q,b.id!,b.owner!,actor,at));return Response.json({ok:true,token},{headers});
  }
  if(b.action==='INTEGRATED' && b.sha!==process.env.VERCEL_GIT_COMMIT_SHA)return Response.json({error:'Integration requires the SHA of this deployed application'},{status:409,headers});
  if((b.action==='FIXED_IN_BRANCH'||b.action==='INTEGRATED')&&b.id&&b.token&&b.sha){
   await update(store(),q=>transition(q,b.id!,b.token!,b.action as 'FIXED_IN_BRANCH'|'INTEGRATED',b.sha!,at));return Response.json({ok:true},{headers});
  }
  return Response.json({error:'Invalid action'},{status:400,headers});
 }catch(e){return failure(e);}
}
