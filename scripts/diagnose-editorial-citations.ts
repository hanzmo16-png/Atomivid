/** Read-only. Only structural statistics leave the runner, never private text. */
import {createClient} from '@supabase/supabase-js';
import {DocumentaryNarrativeSchema} from '../src/lib/video/long-form/documentary-script';
import {EditorialReviewSchema,validateEditorialReview} from '../src/lib/video/long-form/editorial';
const normalized=(s:string)=>s.normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
async function main(){
 const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const latest=await db.from('pi_paid_operations').select('project_id').eq('provider','anthropic').eq('status','COMMITTED').like('project_id','documentary:%').order('created_at',{ascending:false}).limit(1);
 if(latest.error||!latest.data?.[0])throw Error('read');
 const rows=await db.from('pi_paid_operations').select('result_ref').eq('project_id',latest.data[0].project_id).eq('provider','anthropic').eq('status','COMMITTED').order('created_at',{ascending:true});
 if(rows.error)throw Error('read');
 let script:any,review:any;
 for(const row of rows.data??[]){
  const f=await db.storage.from('videos').download(row.result_ref);if(f.error||!f.data)throw Error('read');
  const r=JSON.parse(await f.data.text());if(r.stop_reason!=='end_turn')continue;
  const t=r.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
  let v:any;try{v=JSON.parse(t);}catch{continue;}
  const s=DocumentaryNarrativeSchema.safeParse(v),e=EditorialReviewSchema.safeParse(v);
  if(s.success)script=s.data;if(e.success)review=e.data;
 }
 if(!script||!review)throw Error('matching documents unavailable');
 console.log(JSON.stringify({beats:script.beats.length,sections:review.sections.length,findings:review.findings.map((f:any)=>({kind:f.kind,severity:f.severity,evidence:f.evidence.length})),firstDelivered:review.firstAnswer.delivered,endingResolved:review.ending.resolvesPromise}));
 const citations=[...review.sections.map((e:any,i:number)=>({path:`sections.${i}`,e})),{path:'firstAnswer',e:review.firstAnswer.evidence},{path:'ending',e:review.ending.evidence},...review.findings.flatMap((f:any,i:number)=>f.evidence.map((e:any,j:number)=>({path:`findings.${i}.${j}`,e})))];
 for(const {path,e} of citations){
  const n=script.beats[e.beatIndex]?.narration??'';
  const exact=n.includes(e.quote),norm=normalized(n).includes(normalized(e.quote));
  if(!exact||e.quote.trim().split(/\s+/).length<3)console.log(JSON.stringify({path,beatIndex:e.beatIndex,words:e.quote.trim().split(/\s+/).length,exact,typographyMatch:norm,exactOtherBeats:script.beats.flatMap((b:any,i:number)=>b.narration.includes(e.quote)?[i]:[]),typographyOtherBeats:script.beats.flatMap((b:any,i:number)=>normalized(b.narration).includes(normalized(e.quote))?[i]:[]),hasEllipsis:/\.\.\.|…/.test(e.quote),quoteLength:e.quote.length,onlyPunctuation:!/[a-zA-Z]/.test(e.quote),placeholder:/^(?:n\/?a|none|absent|ausente|ninguna|no\s+cta|\[.*?\]|\(.*?\))$/i.test(e.quote.trim()),ellipsisParts:e.quote.split(/\.{3}|…/).map((p:string)=>({words:p.trim().split(/\s+/).length,found:normalized(n).includes(normalized(p))}))}));
 }
 try{validateEditorialReview(review,script);console.log('review_validation=pass');}catch{console.log('review_validation=fail');}
}
main().catch(()=>{console.error('Read-only editorial diagnostic failed');process.exitCode=1;});
