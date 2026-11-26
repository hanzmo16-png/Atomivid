/** Testable admin boundary. The queue factory is not touched before authentication/authorization. */
import { createHash } from 'node:crypto';
import { requireCommandCenterAdmin, CommandCenterAccessError, type AuthUser } from '../../command-center/access';
import { update, type QueueStore } from './github-store';
import { publicView, claimDefect, transition, event } from './model';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Robots-Tag':'noindex'};
export function qualityHandlers(deps:{auth:()=>Promise<AuthUser>;queue:()=>QueueStore;deployedSha:()=>string|undefined;env?:Record<string,string|undefined>}){
 const failure=(e:unknown)=>Response.json({error:e instanceof CommandCenterAccessError?'Access denied':e instanceof Error&&/CLAIM|TRANSITION|STOPPED/.test(e.message)?e.message:'Quality loop unavailable'}, {status:e instanceof CommandCenterAccessError?e.status:e instanceof Error&&/CLAIM|TRANSITION|STOPPED/.test(e.message)?409:503,headers});
 const gate=async()=>{const user=await deps.auth();requireCommandCenterAdmin(user,deps.env);return createHash('sha256').update(user!.id||'admin').digest('hex').slice(0,16);};
 return {
  async GET(){try{await gate();return Response.json(publicView((await deps.queue().read()).state,new Date().toISOString()),{headers});}catch(e){return failure(e);}},
  async POST(request:Request){try{
   const actor=await gate();const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return Response.json({error:'Origin rejected'},{status:403,headers});
   const b=await request.json() as {action?:string;id?:string;owner?:'codex'|'claude';token?:string;sha?:string};const at=new Date().toISOString();
   if(b.action==='stop'||b.action==='start'){await update(deps.queue(),q=>{q.enabled=b.action==='start';if(!q.enabled)q.lease=null;event(q,at,q.enabled?'Admin activated loop':'Emergency stop by admin');});return Response.json({ok:true},{headers});}
   if(b.action==='claim'&&b.id&&['codex','claude'].includes(b.owner||'')){const token=await update(deps.queue(),q=>claimDefect(q,b.id!,b.owner!,actor,at));return Response.json({ok:true,token},{headers});}
   if(b.action==='INTEGRATED'&&b.sha!==deps.deployedSha())return Response.json({error:'Integration requires this deployed application SHA'},{status:409,headers});
   if((b.action==='FIXED_IN_BRANCH'||b.action==='INTEGRATED')&&b.id&&b.token&&b.sha){await update(deps.queue(),q=>transition(q,b.id!,b.token!,b.action as 'FIXED_IN_BRANCH'|'INTEGRATED',b.sha!,at));return Response.json({ok:true},{headers});}
   return Response.json({error:'Invalid action'},{status:400,headers});
  }catch(e){return failure(e);}},
 };
}
