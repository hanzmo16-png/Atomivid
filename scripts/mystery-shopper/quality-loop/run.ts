import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHubQueueStore, update } from '../../../src/lib/mystery-shopper/quality-loop/github-store';
import { claimCycle, finishCycle, event, publicView, PRODUCTS, type Cycle } from '../../../src/lib/mystery-shopper/quality-loop/model';
import { observe } from './browser';

async function main(){
 const e=process.env,repo=e.GITHUB_REPOSITORY||'hanzmo16-png/Atomivid';
 if(!e.GITHUB_TOKEN)throw new Error('GITHUB_TOKEN_MISSING');
 const store=new GitHubQueueStore(repo,e.GITHUB_TOKEN);
 const startedAt=new Date().toISOString(),kind=e.AQL_TRIGGER||'workflow_dispatch';
 if(!['schedule','deployment_status','workflow_dispatch'].includes(kind))throw new Error('INVALID_TRIGGER');
 if(e.MYSTERY_SHOPPER_AUTO!=='1')throw new Error('MYSTERY_SHOPPER_AUTO_DISABLED');
 // Public Linux standard hosted runners only: private/custom runners need a separately verified quota.
 if(e.AQL_PUBLIC_REPO!=='true'||e.RUNNER_OS!=='Linux')throw new Error('ZERO_COST_ACTIONS_CAPACITY_UNVERIFIED');
 if(!/^[a-f0-9]{40}$/.test(e.GITHUB_SHA||''))throw new Error('RUNNER_SHA_MISSING');
 if(kind==='deployment_status'&&(!/^\d+$/.test(e.AQL_DEPLOYMENT_ID||'')||!/^[a-f0-9]{40}$/.test(e.AQL_EXPECTED_SHA||'')||e.AQL_DEPLOYMENT_STATE!=='success'))throw new Error('DEPLOYMENT_NOT_VERIFIED');
 const id=kind==='schedule'?`schedule-${e.GITHUB_RUN_ID}`:kind==='deployment_status'?`deployment-${e.AQL_DEPLOYMENT_ID}-${e.AQL_EXPECTED_SHA}`:`manual-${e.GITHUB_RUN_ID}`;
 const out=e.MS_OUT_DIR||path.join(process.cwd(),'.quality-loop-out');await mkdir(out,{recursive:true});
 let token:string;
 try{token=await update(store,q=>claimCycle(q,id,startedAt));}
 catch(err){const reason=err instanceof Error?err.message:'';if(['ALREADY_COMPLETED','LEASE_HELD','STOPPED'].includes(reason)){await writeFile(path.join(out,'skipped.json'),JSON.stringify({id,state:reason,spendUsd:0}));console.log(reason);return;}throw err;}
 const stopped=async()=>{const q=(await store.read()).state;return !q.enabled||q.lease?.token!==token;};
 let cycle:Cycle;
 const input={id,trigger:kind as Cycle['trigger'],runnerSha:e.GITHUB_SHA!,url:`https://github.com/${repo}/actions/runs/${e.GITHUB_RUN_ID}`};
 try {cycle=await observe(e,input,stopped);}
 catch {cycle={...input,scope:'authenticated-readonly',startedAt,finishedAt:new Date().toISOString(),sha:null,authenticated:false,sentinel:'BLOCKED',spendUsd:0,checks:PRODUCTS.map(product=>({id:'runner',product,state:'BLOCKED',severity:'P1',owner:'codex',module:'runner',detail:'Runner interrupted or observation unavailable; raw authenticated error omitted'}))};}
 // Readback inside CAS preserves a concurrent emergency stop and fences an expired worker.
 await update(store,q=>finishCycle(q,cycle,token));
 const final=(await store.read()).state;
 await writeFile(path.join(out,'cycle.json'),JSON.stringify(cycle,null,2));
 await writeFile(path.join(out,'summary.json'),JSON.stringify(publicView(final,new Date().toISOString()),null,2));
 const failures=cycle.checks.filter(c=>c.state==='FAIL'),blocks=cycle.checks.filter(c=>c.state==='BLOCKED');
 const signature=createHash('sha256').update(JSON.stringify(cycle.checks.filter(c=>c.state==='FAIL'||c.state==='BLOCKED').map(c=>[c.product,c.id,c.state,c.severity]))).digest('hex');
 if((failures.length||blocks.length)&&final.lastAlert!==signature){
  const r=await fetch(`https://api.github.com/repos/${repo}/issues/320/comments`,{method:'POST',headers:{authorization:`Bearer ${e.GITHUB_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({body:`Quality Loop ${id}: ${failures.length} FAIL, ${blocks.length} BLOCKED. SHA evaluado: ${cycle.sha||'NO VERIFICADO'}. Responsables y reclamos en cola persistente; no se activó sesión externa. ${cycle.url}`}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error(`ALERT_HTTP_${r.status}`);
  await update(store,q=>{q.lastAlert=signature;});
 }
 if(e.GITHUB_STEP_SUMMARY)await writeFile(e.GITHUB_STEP_SUMMARY,`### AUTONOMOUS QUALITY LOOP\n\n${id} · SHA ${cycle.sha||'NO VERIFICADO'} · USD 0 de proveedores\n\nPASS ${cycle.checks.filter(c=>c.state==='PASS').length} / FAIL ${failures.length} / BLOCKED ${blocks.length}\n\nAuthenticated: ${cycle.authenticated}; Sentinel: ${cycle.sentinel}.\n`,{flag:'a'});
 if(failures.length||blocks.length)process.exitCode=1;
 event(final,new Date().toISOString(),'Summary emitted');
}
main().catch((e)=>{const message=e instanceof Error&&/^[A-Z_0-9]+$/.test(e.message)?e.message:'RUNNER_UNAVAILABLE';console.error(`Quality loop blocked: ${message}; credentials/HTTP bodies omitted`);process.exitCode=1;});
