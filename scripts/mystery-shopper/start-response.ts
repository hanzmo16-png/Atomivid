import { parseStartOutcome } from '../../src/lib/video/start-outcome';
/** Release only this runner's unstarted-render hold when the server supplies a complete typed proof. */
export function provedUnstartedRender(body: unknown): boolean {
 const outcome=parseStartOutcome((body as {outcome?:unknown}|null)?.outcome);
 return outcome!==null&&outcome.charge==='none_proven'&&outcome.attempts>=0&&(outcome.status==='script_ready'||outcome.status==='failed');
}
export function matchesRenderStartResponse(base: string, configure: string, actual: string, method: string): boolean {
 try {
  const origin=new URL(base).origin,request=new URL(actual),page=new URL(configure,base);
  const id=/^\/dashboard\/long-form\/configure\/([0-9a-f-]{36})$/.exec(page.pathname)?.[1];
  return !!id&&page.origin===origin&&request.origin===origin&&request.pathname===`/api/generate/${id}/render`&&method==='POST';
 }catch{return false;}
}
