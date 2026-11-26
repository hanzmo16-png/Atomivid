/** Separate capability for server-configured isolated Preview tests, never production or Reels. */
import type { RenderWorker } from './types';
import { githubActionsWorker, GitHubWorkerDispatchError, GitHubWorkerNetworkError } from './github-actions';
import { MissingEnvVarError, InvalidEnvVarError } from '@/lib/env-errors';
export const githubActionsQaWorker: RenderWorker = {
 name:'github-actions',
 async trigger(input){
  const {requestId,mode,longFormJobTimeoutMin}=input;
  const ref=process.env.GH_WORKER_QA_REF;
  if(process.env.VERCEL_ENV!=='preview'||mode!=='long_form'||!ref)return githubActionsWorker.trigger(input);
  if(!/^codex\/endgame-[a-z0-9-]+$/.test(ref))throw new InvalidEnvVarError('GH_WORKER_QA_REF','an isolated codex/endgame-* branch');
  const token=process.env.GH_WORKER_TOKEN,repo=process.env.GH_WORKER_REPO;
  if(!token)throw new MissingEnvVarError('GH_WORKER_TOKEN');if(!repo)throw new MissingEnvVarError('GH_WORKER_REPO');
  if(!/^[^\s/]+\/[^\s/]+$/.test(repo))throw new InvalidEnvVarError('GH_WORKER_REPO','owner/repo');
  if(longFormJobTimeoutMin===undefined||![45,90,180].includes(longFormJobTimeoutMin))throw new GitHubWorkerDispatchError(409,'QA requires an explicit bounded short-job timeout.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  try{
   const checked=await fetch(`https://api.github.com/repos/${repo}/contents/.github/workflows/render.yml?ref=${encodeURIComponent(ref)}`,{headers,signal:controller.signal});
   const file=checked.ok?await checked.json().catch(()=>null)as{content?:string;encoding?:string}|null:null;
   const source=file?.encoding==='base64'&&typeof file.content==='string'?Buffer.from(file.content,'base64').toString('utf8'):'';
   if(!source.includes('# LONG_FORM_RENDER_TIMEOUT_PROTOCOL=1')||!source.includes('LONG_FORM_RENDER_JOB_TIMEOUT_MIN:'))throw new GitHubWorkerDispatchError(409,'Remote render timeout policy is not active.');
   if(!source.includes('# PRIVATE_LONG_FORM_FAILURE_PROTOCOL=1'))throw new GitHubWorkerDispatchError(409,'Private QA failure recovery is not active.');
   const res=await fetch(`https://api.github.com/repos/${repo}/actions/workflows/render.yml/dispatches`,{method:'POST',headers,body:JSON.stringify({ref,inputs:{request_id:requestId,mode:'long_form',long_form_timeout_minutes:String(longFormJobTimeoutMin)}}),signal:controller.signal});
   if(!res.ok)throw new GitHubWorkerDispatchError(res.status,await res.text().catch(()=>''));
  }catch(error){if(error instanceof GitHubWorkerDispatchError)throw error;throw new GitHubWorkerNetworkError(error);}finally{clearTimeout(timer);}
 }
};
