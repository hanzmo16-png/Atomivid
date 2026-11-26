import {createHash} from 'node:crypto';
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
export const canonicalSha=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
export function boundEditorialResume(q,a,source){
 return q.id==='ed438c74-b0bb-43e1-8153-ea8c993d9877'&&q.status==='script_ready'&&q.render_attempts===2&&!!q.long_form_confirmed_at&&a.scope==='ONE_QA_EDITORIAL_APPLIED'&&a.requestId===q.id&&a.attemptsPreserved===2&&Number.isFinite(Date.parse(a.confirmedAt))&&Date.parse(a.confirmedAt)===Date.parse(q.long_form_confirmed_at)&&source.scope==='ONE_QA_EDITORIAL_MATERIAL_PREFLIGHT'&&source.original?.id===q.id&&source.original?.user_id===q.user_id&&source.original.render_attempts===2&&source.pre?.status==='ok'&&canonicalSha(q.script_json)===a.proposedScriptSha256&&canonicalSha(q.long_form_production_plan)===a.confirmedPlanSha256;
}
