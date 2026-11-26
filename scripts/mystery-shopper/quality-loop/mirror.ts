/** Existing Drive channel + OIDC credential exchange; no paid executor and no production writes. */
import { GitHubQueueStore, update } from '../../../src/lib/mystery-shopper/quality-loop/github-store';
import { DriveRestChannel, oidcDriveTokenProvider } from '../../../src/lib/orchestrator/channel';
import { renderHeader, taskDigest } from '../../../src/lib/orchestrator/protocol';
async function main(){
 const env=process.env,repo=env.GITHUB_REPOSITORY||'hanzmo16-png/Atomivid';
 if(env.GITHUB_REF_NAME!==env.AQL_DEFAULT_BRANCH)throw new Error('DEFAULT_BRANCH_ONLY');
 const store=new GitHubQueueStore(repo,env.GITHUB_TOKEN);
 const channel=new DriveRestChannel({solicitudes:'1WJ4FpKjMvOpn60i3diyy7sL7uDQfZp9W',entregas:'1z8C1ZnE8rh9iUUiEYQrNU-x7VMzCI4SJ'},oidcDriveTokenProvider('https://atomivid.vercel.app/api/orchestrator/drive/token'));
 try{
  const snapshot=await store.read();const q=snapshot.state;
  const queueText=JSON.stringify(q,null,2);
  const name=`QUALITY-LOOP-${env.GITHUB_RUN_ID}-${snapshot.revision?.slice(0,12)||'initial'}__orquestador__ESTADO.md`;
  const saved=await channel.createIfAbsent('entregas',name,queueText);
  if(await channel.read(saved.id)!==queueText)throw new Error('DRIVE_READBACK_MISMATCH');
  const deliveries=await channel.list('entregas');
  let published=0;
  for(const d of q.defects.filter(d=>(d.state==='DETECTED'||d.state==='CLAIMED')&&!d.driveId).slice(0,3)){
   const priorAck=deliveries.find(f=>f.name.startsWith(`${d.taskId}__${d.owner}__`)&&/ACK|EN_PROCESO|ENTREGADO/i.test(f.name));
   if(priorAck)continue;
   const content=renderHeader({id:d.taskId,de:'orquestador',para:d.owner,estado:'SOLICITADO',raiz:'issue-320',presupuesto_usd:0,defecto:d.id,sha:d.sha||'UNKNOWN',archivos:d.module,pide:`Corregir y revalidar ${d.checkId}`,criterio_de_hecho:'PR y SHA + repetición del mismo check; no cerrar con fixture como producción',requiere_gasto_o_produccion:'no'})+`\n\nEvidencia: ${d.evidence}\nClaim atómico obligatorio en Command Center Quality Loop antes de editar. Revisar #320 y no solapar Sentinel #337/#338 ni claude/hola-sn3dxy. No pagado, secretos, migraciones o Premium. No existe activación de sesión por publicar este archivo.\n`;
   const result=await channel.createIfAbsent('solicitudes',`${d.taskId}__para-${d.owner}__quality-loop-${d.id}.md`,content);
   if(await channel.read(result.id)!==content)throw new Error('TASK_READBACK_MISMATCH');
   await update(store,s=>{const target=s.defects.find(x=>x.id===d.id);if(target)target.driveId=result.id;});published++;
   // taskDigest is reusable handoff evidence; no executor is implicitly activated.
   console.log(`Handoff ${d.id} ${taskDigest(content).slice(0,12)} verified`);
  }
  await update(store,s=>{s.mirror={at:new Date().toISOString(),state:'VERIFIED'};});console.log(`Drive mirror read back; ${published} handoffs; zero paid calls`);
 }catch{await update(store,s=>{s.mirror={at:new Date().toISOString(),state:'BLOCKED'};});throw new Error('DRIVE_MIRROR_BLOCKED');}
}
main().catch(()=>{console.error('Drive mirror blocked; token and private responses omitted');process.exitCode=1;});
